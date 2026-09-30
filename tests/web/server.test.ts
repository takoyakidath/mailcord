import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from '../../src/web/server';
import type { ResendClient } from '../../src/mail/resendClient';
import type { DiscordPoster } from '../../src/services/inboundEmailService';
import { createDb } from '../../src/db/client';
import { createBinding, resolveBindingByChannel } from '../../src/services/bindingService';
import { createOauthState } from '../../src/services/oauthStateService';

// Resend webhook signatures follow the Svix scheme: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${payload}`)),
// with the secret being the base64 payload after the `whsec_` prefix.
function signSvix(secret: string, id: string, timestamp: string, payload: string): string {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${payload}`;
  const sig = createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

describe('POST /webhooks/resend/inbound', () => {
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const spamChannelId = 'spam-chan';

  it('returns 401 when the signature is invalid', async () => {
    const db = createDb(':memory:');
    const resend = { verifyWebhookSignature: vi.fn().mockResolvedValue(null) } as unknown as ResendClient;
    const poster = { postEmailMessage: vi.fn() } as unknown as DiscordPoster;
    const app = createServer(db, resend, poster, secret, spamChannelId, null);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/resend/inbound',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_1',
        'svix-timestamp': '1700000000',
        'svix-signature': 'v1,invalid',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 500 (so Resend retries) when inbound handling throws', async () => {
    const db = createDb(':memory:');
    const resend = {
      verifyWebhookSignature: vi.fn().mockResolvedValue({
        type: 'email.received',
        data: { email_id: 'email-1', from: 'friend@example.com', to: ['tako@octo.jp'], subject: 'Hi' },
      }),
      getReceivedEmail: vi.fn().mockRejectedValue(new Error('resend is down')),
      getAttachmentDownloadUrl: vi.fn(),
      sendEmail: vi.fn(),
    } as unknown as ResendClient;
    const poster = { postEmailMessage: vi.fn() } as unknown as DiscordPoster;
    const app = createServer(db, resend, poster, secret, spamChannelId, null);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/resend/inbound',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_1',
        'svix-timestamp': '1700000000',
        'svix-signature': 'v1,whatever',
      },
    });

    expect(response.statusCode).toBe(500);
    expect(poster.postEmailMessage).not.toHaveBeenCalled();
  });

  it('verifies a genuine Svix-style signature and invokes the inbound handler', async () => {
    const db = createDb(':memory:');
    await createBinding(db, {
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });

    const payload = JSON.stringify({
      type: 'email.received',
      created_at: '2026-08-27T00:00:00.000Z',
      data: { email_id: 'email-1', from: 'friend@example.com', to: ['tako@octo.jp'], subject: 'Hi' },
    });
    const id = 'msg_1';
    // The real Svix/standardwebhooks verifier enforces a 5-minute freshness window against
    // wall-clock time, so the timestamp must be "now" rather than a fixed historical value.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signSvix(secret, id, timestamp, payload);

    const { Resend } = await import('resend');
    const realResend = new Resend('re_test');
    // Exercise the real Resend SDK's verification against our manually-built signature.
    // `webhooks.verify` in the installed resend v6.24.0 is synchronous (backed by the
    // `standardwebhooks` package) and throws on an invalid signature rather than returning
    // null, so we call it directly (not with `.resolves`) and let a throw fail the test.
    // If this throws on a signature mismatch, the manual signing above no longer matches
    // the SDK's algorithm — inspect node_modules/resend's webhooks implementation and
    // adjust `signSvix`.
    expect(
      realResend.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret: secret }),
    ).toMatchObject({ type: 'email.received' });

    const resend = {
      verifyWebhookSignature: vi.fn().mockResolvedValue({
        type: 'email.received',
        data: { email_id: 'email-1', from: 'friend@example.com', to: ['tako@octo.jp'], subject: 'Hi' },
      }),
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-1',
        from: 'friend@example.com',
        to: ['tako@octo.jp'],
        subject: 'Hi',
        text: 'body',
        html: '',
        headers: {},
        attachments: [],
      }),
      getAttachmentDownloadUrl: vi.fn(),
      sendEmail: vi.fn(),
    } as unknown as ResendClient;
    const poster = { postEmailMessage: vi.fn().mockResolvedValue({ discordMessageId: 'discord-msg-1' }) } as unknown as DiscordPoster;
    const app = createServer(db, resend, poster, secret, spamChannelId, null);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/resend/inbound',
      payload,
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': signature,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(poster.postEmailMessage).toHaveBeenCalled();
  });
});

describe('GET /oauth/gmail/callback', () => {
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const spamChannelId = 'spam-chan';

  function fakeGmail(overrides: Partial<import('../../src/mail/gmailClient').GmailClient> = {}) {
    return {
      client: {
        exchangeCodeForTokens: vi.fn().mockResolvedValue({ refreshToken: 'r1', accessToken: 'a1', expiresAt: new Date(Date.now() + 3600_000) }),
        getProfile: vi.fn().mockResolvedValue({ emailAddress: 'tako@gmail.com', historyId: '1' }),
        ...overrides,
      } as unknown as import('../../src/mail/gmailClient').GmailClient,
      tokenEncryptionKey: '00'.repeat(32),
    };
  }

  it('returns 404 when Gmail is not configured', async () => {
    const db = createDb(':memory:');
    const resend = {} as unknown as ResendClient;
    const poster = { postEmailMessage: vi.fn(), postSystemMessage: vi.fn() } as unknown as DiscordPoster;
    const app = createServer(db, resend, poster, secret, spamChannelId, null);

    const response = await app.inject({ method: 'GET', url: '/oauth/gmail/callback?code=x&state=y' });

    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for a missing or expired state without creating a binding', async () => {
    const db = createDb(':memory:');
    const resend = {} as unknown as ResendClient;
    const poster = { postEmailMessage: vi.fn(), postSystemMessage: vi.fn() } as unknown as DiscordPoster;
    const gmail = fakeGmail();
    const app = createServer(db, resend, poster, secret, spamChannelId, gmail);

    const response = await app.inject({ method: 'GET', url: '/oauth/gmail/callback?code=abc&state=never-issued' });

    expect(response.statusCode).toBe(400);
    expect(gmail.client.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('treats ?error= as a cancelled consent, not a failure', async () => {
    const db = createDb(':memory:');
    const resend = {} as unknown as ResendClient;
    const poster = { postEmailMessage: vi.fn(), postSystemMessage: vi.fn() } as unknown as DiscordPoster;
    const gmail = fakeGmail();
    const app = createServer(db, resend, poster, secret, spamChannelId, gmail);

    const response = await app.inject({ method: 'GET', url: '/oauth/gmail/callback?error=access_denied&state=whatever' });

    expect(response.statusCode).toBe(200);
    expect(gmail.client.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('on a valid state, creates a gmail binding and confirms in-channel', async () => {
    const db = createDb(':memory:');
    const resend = {} as unknown as ResendClient;
    const poster = { postEmailMessage: vi.fn(), postSystemMessage: vi.fn().mockResolvedValue({ discordMessageId: 'sys-1' }) } as unknown as DiscordPoster;
    const gmail = fakeGmail();
    const app = createServer(db, resend, poster, secret, spamChannelId, gmail);

    const state = await createOauthState(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', requestedBy: 'u1' });

    const response = await app.inject({ method: 'GET', url: `/oauth/gmail/callback?code=abc&state=${state}` });

    expect(response.statusCode).toBe(200);
    const binding = await resolveBindingByChannel(db, 'chan-1');
    expect(binding?.emailAddress).toBe('tako@gmail.com');
    expect(binding?.provider).toBe('gmail');
    expect(poster.postSystemMessage).toHaveBeenCalledWith('chan-1', expect.stringContaining('tako@gmail.com'));
  });

  it('rejects a replayed state on a second request', async () => {
    const db = createDb(':memory:');
    const resend = {} as unknown as ResendClient;
    const poster = { postEmailMessage: vi.fn(), postSystemMessage: vi.fn() } as unknown as DiscordPoster;
    const gmail = fakeGmail();
    const app = createServer(db, resend, poster, secret, spamChannelId, gmail);

    const state = await createOauthState(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', requestedBy: 'u1' });
    await app.inject({ method: 'GET', url: `/oauth/gmail/callback?code=abc&state=${state}` });

    const second = await app.inject({ method: 'GET', url: `/oauth/gmail/callback?code=abc&state=${state}` });
    expect(second.statusCode).toBe(400);
  });
});
