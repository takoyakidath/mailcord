import { OAuth2Client } from 'google-auth-library';

export interface GmailHistoryResult {
  newMessages: { id: string; threadId: string }[];
  newHistoryId: string;
  /** True on a 404 ("historyId too old") — caller must re-baseline instead of trusting newMessages. */
  historyGone: boolean;
}

export interface GmailMessageMetadata {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  labelIds: string[];
  messageIdHeader: string;
  inReplyTo: string | null;
  references: string | null;
}

export interface GmailClient {
  buildAuthUrl(state: string): string;
  exchangeCodeForTokens(code: string): Promise<{ refreshToken: string; accessToken: string; expiresAt: Date }>;
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }>;
  getProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string }>;
  listHistory(accessToken: string, startHistoryId: string): Promise<GmailHistoryResult>;
  getMessageMetadata(accessToken: string, messageId: string): Promise<GmailMessageMetadata>;
  sendRawMessage(accessToken: string, raw: Buffer, threadId?: string): Promise<{ id: string; threadId: string }>;
}

// Least-privilege scopes: readonly (metadata polling never requests format=full/raw, see
// getMessageMetadata below) + send. Deliberately not the broad `https://mail.google.com/` scope.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const METADATA_HEADERS = ['Subject', 'From', 'Message-ID', 'In-Reply-To', 'References'];

class GmailApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function headerValue(headers: { name: string; value: string }[], name: string): string | null {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

async function gmailFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GMAIL_API_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new GmailApiError(`Gmail API request failed (${response.status}): ${await response.text()}`, response.status);
  }
  return response.json() as Promise<T>;
}

export function createGmailClient(clientId: string, clientSecret: string, redirectUri: string): GmailClient {
  const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);

  return {
    buildAuthUrl(state) {
      return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        // Forces Google to hand back a refresh token even if this Google account has already
        // authorized this app before (otherwise a re-bind after `/mail unbind` could silently
        // fail to get one).
        prompt: 'consent',
        scope: SCOPES,
        state,
      });
    },

    async exchangeCodeForTokens(code) {
      const { tokens } = await oauth2Client.getToken(code);
      if (!tokens.refresh_token || !tokens.access_token || !tokens.expiry_date) {
        throw new Error('Google did not return a refresh token for this authorization code');
      }
      return {
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        expiresAt: new Date(tokens.expiry_date),
      };
    },

    async refreshAccessToken(refreshToken) {
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await oauth2Client.refreshAccessToken();
      if (!credentials.access_token || !credentials.expiry_date) {
        throw new Error('Google did not return a refreshed access token');
      }
      return { accessToken: credentials.access_token, expiresAt: new Date(credentials.expiry_date) };
    },

    async getProfile(accessToken) {
      const data = await gmailFetch<{ emailAddress: string; historyId: string | number }>(accessToken, '/profile');
      return { emailAddress: data.emailAddress, historyId: String(data.historyId) };
    },

    async listHistory(accessToken, startHistoryId) {
      const newMessages: { id: string; threadId: string }[] = [];
      let newHistoryId = startHistoryId;
      let pageToken: string | undefined;

      do {
        const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX' });
        if (pageToken) params.set('pageToken', pageToken);

        let page: {
          history?: { messagesAdded?: { message: { id: string; threadId: string } }[] }[];
          historyId?: string | number;
          nextPageToken?: string;
        };
        try {
          page = await gmailFetch(accessToken, `/history?${params.toString()}`);
        } catch (err) {
          // Gmail expires history entries after roughly a week; a 404 here means the stored
          // cursor fell off that window. Reconstructing exactly what was missed isn't possible,
          // so the caller re-baselines from the current profile instead of guessing.
          if (err instanceof GmailApiError && err.status === 404) {
            return { newMessages: [], newHistoryId: startHistoryId, historyGone: true };
          }
          throw err;
        }

        for (const entry of page.history ?? []) {
          for (const added of entry.messagesAdded ?? []) {
            newMessages.push({ id: added.message.id, threadId: added.message.threadId });
          }
        }
        if (page.historyId !== undefined) newHistoryId = String(page.historyId);
        pageToken = page.nextPageToken;
      } while (pageToken);

      return { newMessages, newHistoryId, historyGone: false };
    },

    async getMessageMetadata(accessToken, messageId) {
      const params = new URLSearchParams({ format: 'metadata' });
      for (const header of METADATA_HEADERS) params.append('metadataHeaders', header);
      // format=metadata + an explicit metadataHeaders allowlist is what keeps the message body
      // out of this process entirely — never request format=full/raw here. That's the actual
      // privacy boundary for "Gmail-sourced Discord embeds carry no body text" (the readonly
      // scope itself would technically permit fetching bodies too).
      const data = await gmailFetch<{
        id: string;
        threadId: string;
        labelIds?: string[];
        payload?: { headers?: { name: string; value: string }[] };
      }>(accessToken, `/messages/${messageId}?${params.toString()}`);
      const headers = data.payload?.headers ?? [];
      return {
        id: data.id,
        threadId: data.threadId,
        subject: headerValue(headers, 'Subject') ?? '(件名なし)',
        from: headerValue(headers, 'From') ?? '',
        labelIds: data.labelIds ?? [],
        messageIdHeader: headerValue(headers, 'Message-ID') ?? data.id,
        inReplyTo: headerValue(headers, 'In-Reply-To'),
        references: headerValue(headers, 'References'),
      };
    },

    async sendRawMessage(accessToken, raw, threadId) {
      const data = await gmailFetch<{ id: string; threadId: string }>(accessToken, '/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) }),
      });
      return { id: data.id, threadId: data.threadId };
    },
  };
}
