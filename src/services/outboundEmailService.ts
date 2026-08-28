import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import type { ResendClient, OutboundAttachment } from '../mail/resendClient';
import { resolveBindingByChannel } from './bindingService';
import { resolveThreadByDiscordMessageId, recordThreadMessage } from './threadService';
import { buildReplyHeaders, buildReplySubject } from '../mail/headers';
import { extractEmailAddress } from '../mail/address';

// Resend's send API returns its own email id (a bare UUID), which is NOT an RFC-5322
// Message-ID. Storing that in email_threads.email_message_id would put a malformed value
// into the In-Reply-To/References of the next reply, so generate a real Message-ID here
// and hand the same value to both Resend and the thread record.
// Resend accepts at most 40MB per email *after* base64 encoding, so budget in encoded bytes.
const MAX_ENCODED_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const SKIPPED_ATTACHMENT_NOTE = '\n\n(添付は容量超過のため省略されました)';

function limitAttachments(attachments: OutboundAttachment[] | undefined): {
  attachments: OutboundAttachment[] | undefined;
  skipped: boolean;
} {
  if (!attachments || attachments.length === 0) return { attachments, skipped: false };

  const kept: OutboundAttachment[] = [];
  let encodedTotal = 0;
  let skipped = false;
  for (const att of attachments) {
    const encodedSize = Math.ceil(att.content.byteLength / 3) * 4;
    if (encodedTotal + encodedSize > MAX_ENCODED_ATTACHMENT_BYTES) {
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
}

// Shared by sendNewEmail and sendReplyEmail: send via Resend, then record the thread row for
// future reply resolution. These are two separate failure domains — if the send itself fails,
// nothing happened and the caller should see an error. If the send succeeds but *recording*
// fails, the email already went out; reporting that as a failure would make the user retry and
// double-send, so a bookkeeping failure here is logged, not surfaced as ok:false. The cost is a
// thread that isn't reply-able until investigated, which is far cheaper than a duplicate email.
async function sendAndRecord(db: Db, resend: ResendClient, params: SendAndRecordParams): Promise<OutboundResult> {
  let emailId: string;
  try {
    const result = await resend.sendEmail({
      from: params.from,
      to: params.to,
      subject: params.subject,
      text: params.skippedAttachments ? params.body + SKIPPED_ATTACHMENT_NOTE : params.body,
      headers: params.headers,
      attachments: params.attachments,
    });
    emailId = result.id;
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

export async function sendNewEmail(db: Db, resend: ResendClient, input: SendNewEmailInput): Promise<OutboundResult> {
  const binding = await resolveBindingByChannel(db, input.discordChannelId);
  if (!binding) {
    return { ok: false, error: 'このチャンネルはメールアドレスにバインドされていません。/mail bind で設定してください。' };
  }

  const messageId = generateMessageId(binding.emailAddress);
  const limited = limitAttachments(input.attachments);

  return sendAndRecord(db, resend, {
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
  });
}

export interface SendReplyEmailInput {
  discordChannelId: string;
  discordMessageId: string;
  repliedToDiscordMessageId: string;
  body: string;
  attachments?: OutboundAttachment[];
}

export async function sendReplyEmail(db: Db, resend: ResendClient, input: SendReplyEmailInput): Promise<OutboundResult> {
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
  const limited = limitAttachments(input.attachments);

  return sendAndRecord(db, resend, {
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
  });
}
