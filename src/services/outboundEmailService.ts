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
function generateMessageId(fromAddress: string): string {
  const domain = extractEmailAddress(fromAddress).split('@').pop() || 'localhost';
  return `<${randomUUID()}@${domain}>`;
}

export type OutboundResult = { ok: true; emailId: string } | { ok: false; error: string };

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

  try {
    const { id } = await resend.sendEmail({
      from: binding.emailAddress,
      to: input.to,
      subject: input.subject,
      text: input.body,
      headers: { 'Message-ID': messageId },
      attachments: input.attachments,
    });

    await recordThreadMessage(db, {
      discordMessageId: input.discordMessageId,
      bindingId: binding.id,
      externalAddress: input.to,
      subject: input.subject,
      emailMessageId: messageId,
      inReplyTo: null,
      referencesChain: null,
      direction: 'outbound',
    });

    return { ok: true, emailId: id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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

  try {
    const { id } = await resend.sendEmail({
      from: binding.emailAddress,
      to: originalThread.externalAddress,
      subject,
      text: input.body,
      headers: { 'Message-ID': messageId, 'In-Reply-To': inReplyTo, References: references },
      attachments: input.attachments,
    });

    await recordThreadMessage(db, {
      discordMessageId: input.discordMessageId,
      bindingId: binding.id,
      externalAddress: originalThread.externalAddress,
      subject,
      emailMessageId: messageId,
      inReplyTo,
      referencesChain: references,
      direction: 'outbound',
    });

    return { ok: true, emailId: id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
