import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import type { ResendClient, OutboundAttachment } from '../mail/resendClient';
import type { GmailClient } from '../mail/gmailClient';
import { buildRfc822Message } from '../mail/rfc822';
import { resolveBindingByChannel, type Binding } from './bindingService';
import { resolveThreadByDiscordMessageId, recordThreadMessage } from './threadService';
import { getGmailAccountByBindingId, getLiveAccessToken } from './gmailAccountService';
import { buildReplyHeaders, buildReplySubject } from '../mail/headers';
import { extractEmailAddress } from '../mail/address';

// Resend's send API returns its own email id (a bare UUID), which is NOT an RFC-5322
// Message-ID. Storing that in email_threads.email_message_id would put a malformed value
// into the In-Reply-To/References of the next reply, so generate a real Message-ID here
// and hand the same value to both Resend and the thread record. Gmail sends reuse the same
// generator: it's keyed off the `from` address's domain, not the provider.
const MAX_ENCODED_ATTACHMENT_BYTES_RESEND = 40 * 1024 * 1024;
// Gmail's raw-message size cap is smaller than Resend's post-encoding budget.
const MAX_ENCODED_ATTACHMENT_BYTES_GMAIL = 35 * 1024 * 1024;
const SKIPPED_ATTACHMENT_NOTE = '\n\n(添付は容量超過のため省略されました)';

function limitAttachments(
  attachments: OutboundAttachment[] | undefined,
  maxEncodedBytes: number,
): { attachments: OutboundAttachment[] | undefined; skipped: boolean } {
  if (!attachments || attachments.length === 0) return { attachments, skipped: false };

  const kept: OutboundAttachment[] = [];
  let encodedTotal = 0;
  let skipped = false;
  for (const att of attachments) {
    const encodedSize = Math.ceil(att.content.byteLength / 3) * 4;
    if (encodedTotal + encodedSize > maxEncodedBytes) {
      skipped = true;
      continue;
    }
    encodedTotal += encodedSize;
    kept.push(att);
  }
  return { attachments: kept, skipped };
}

function generateMessageId(fromAddress: string): string {
  const domain = extractEmailAddress(fromAddress).split('@').pop() || 'localhost';
  return `<${randomUUID()}@${domain}>`;
}

export type OutboundResult = { ok: true; emailId: string } | { ok: false; error: string };

// A Gmail-bound channel's provider client + the key needed to decrypt its stored OAuth tokens.
// Bundled together (rather than threading the key separately) so there's one null-check point
// for "Gmail isn't configured on this deployment" wherever sending happens.
export interface GmailProvider {
  client: GmailClient;
  tokenEncryptionKey: string;
}

export interface OutboundProviders {
  resend: ResendClient;
  gmail: GmailProvider | null;
}

interface SendAndRecordParams {
  from: string;
  to: string;
  subject: string;
  body: string;
  headers: Record<string, string>;
  attachments: OutboundAttachment[] | undefined;
  skippedAttachments: boolean;
  messageId: string;
  discordMessageId: string;
  bindingId: number;
  inReplyTo: string | null;
  referencesChain: string | null;
  /** Gmail's native thread id to reply into, if this is a reply to a Gmail-sourced thread. */
  gmailReplyThreadId: string | null;
}

// Shared by sendNewEmail and sendReplyEmail: send via the binding's provider, then record the
// thread row for future reply resolution. These are two separate failure domains — if the send
// itself fails, nothing happened and the caller should see an error. If the send succeeds but
// *recording* fails, the email already went out; reporting that as a failure would make the user
// retry and double-send, so a bookkeeping failure here is logged, not surfaced as ok:false. The
// cost is a thread that isn't reply-able until investigated, which is far cheaper than a
// duplicate email. This holds for both providers.
async function sendAndRecord(
  db: Db,
  providers: OutboundProviders,
  binding: Binding,
  params: SendAndRecordParams,
): Promise<OutboundResult> {
  const text = params.skippedAttachments ? params.body + SKIPPED_ATTACHMENT_NOTE : params.body;
  let emailId: string;
  let gmailThreadId: string | null = null;

  try {
    if (binding.provider === 'gmail') {
      if (!providers.gmail) return { ok: false, error: 'Gmail連携が設定されていません。' };
      const account = await getGmailAccountByBindingId(db, binding.id);
      if (!account) return { ok: false, error: 'Gmailアカウントの認証情報が見つかりません。/mail unbind の後、再度 /mail bind-gmail してください。' };

      const accessToken = await getLiveAccessToken(db, providers.gmail.client, providers.gmail.tokenEncryptionKey, account);
      const raw = buildRfc822Message({
        from: params.from,
        to: params.to,
        subject: params.subject,
        body: text,
        headers: params.headers,
        attachments: params.attachments,
      });
      const sendResult = await providers.gmail.client.sendRawMessage(accessToken, raw, params.gmailReplyThreadId ?? undefined);
      emailId = sendResult.id;
      gmailThreadId = sendResult.threadId;
    } else {
      const result = await providers.resend.sendEmail({
        from: params.from,
        to: params.to,
        subject: params.subject,
        text,
        headers: params.headers,
        attachments: params.attachments,
      });
      emailId = result.id;
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    await recordThreadMessage(db, {
      discordMessageId: params.discordMessageId,
      bindingId: params.bindingId,
      externalAddress: params.to,
      subject: params.subject,
      emailMessageId: params.messageId,
      inReplyTo: params.inReplyTo,
      referencesChain: params.referencesChain,
      direction: 'outbound',
      gmailThreadId,
    });
  } catch (err) {
    console.error('recordThreadMessage failed after a successful send:', err);
  }

  return { ok: true, emailId };
}

export interface SendNewEmailInput {
  discordChannelId: string;
  discordMessageId: string;
  to: string;
  subject: string;
  body: string;
  attachments?: OutboundAttachment[];
}

export async function sendNewEmail(db: Db, providers: OutboundProviders, input: SendNewEmailInput): Promise<OutboundResult> {
  const binding = await resolveBindingByChannel(db, input.discordChannelId);
  if (!binding) {
    return { ok: false, error: 'このチャンネルはメールアドレスにバインドされていません。/mail bind で設定してください。' };
  }

  const messageId = generateMessageId(binding.emailAddress);
  const maxEncodedBytes = binding.provider === 'gmail' ? MAX_ENCODED_ATTACHMENT_BYTES_GMAIL : MAX_ENCODED_ATTACHMENT_BYTES_RESEND;
  const limited = limitAttachments(input.attachments, maxEncodedBytes);

  return sendAndRecord(db, providers, binding, {
    from: binding.emailAddress,
    to: input.to,
    subject: input.subject,
    body: input.body,
    headers: { 'Message-ID': messageId },
    attachments: limited.attachments,
    skippedAttachments: limited.skipped,
    messageId,
    discordMessageId: input.discordMessageId,
    bindingId: binding.id,
    inReplyTo: null,
    referencesChain: null,
    gmailReplyThreadId: null,
  });
}

export interface SendReplyEmailInput {
  discordChannelId: string;
  discordMessageId: string;
  repliedToDiscordMessageId: string;
  body: string;
  attachments?: OutboundAttachment[];
}

export async function sendReplyEmail(db: Db, providers: OutboundProviders, input: SendReplyEmailInput): Promise<OutboundResult> {
  const binding = await resolveBindingByChannel(db, input.discordChannelId);
  if (!binding) {
    return { ok: false, error: 'このチャンネルはメールアドレスにバインドされていません。' };
  }

  const originalThread = await resolveThreadByDiscordMessageId(db, input.repliedToDiscordMessageId);
  if (!originalThread) {
    return { ok: false, error: '返信先のメールスレッドが見つかりませんでした。' };
  }

  const { inReplyTo, references } = buildReplyHeaders(originalThread.emailMessageId, originalThread.referencesChain);
  const subject = buildReplySubject(originalThread.subject);

  const messageId = generateMessageId(binding.emailAddress);
  const maxEncodedBytes = binding.provider === 'gmail' ? MAX_ENCODED_ATTACHMENT_BYTES_GMAIL : MAX_ENCODED_ATTACHMENT_BYTES_RESEND;
  const limited = limitAttachments(input.attachments, maxEncodedBytes);

  return sendAndRecord(db, providers, binding, {
    from: binding.emailAddress,
    to: originalThread.externalAddress,
    subject,
    body: input.body,
    headers: { 'Message-ID': messageId, 'In-Reply-To': inReplyTo, References: references },
    attachments: limited.attachments,
    skippedAttachments: limited.skipped,
    messageId,
    discordMessageId: input.discordMessageId,
    bindingId: binding.id,
    inReplyTo,
    referencesChain: references,
    gmailReplyThreadId: originalThread.gmailThreadId,
  });
}
