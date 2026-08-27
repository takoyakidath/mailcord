import type { Db } from '../db/client';
import type { ResendClient, OutboundAttachment } from '../mail/resendClient';
import { resolveBindingByChannel } from './bindingService';
import { resolveThreadByDiscordMessageId, recordThreadMessage } from './threadService';
import { buildReplyHeaders, buildReplySubject } from '../mail/headers';

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

  try {
    const { id } = await resend.sendEmail({
      from: binding.emailAddress,
      to: input.to,
      subject: input.subject,
      text: input.body,
      attachments: input.attachments,
    });

    await recordThreadMessage(db, {
      discordMessageId: input.discordMessageId,
      bindingId: binding.id,
      externalAddress: input.to,
      subject: input.subject,
      emailMessageId: id,
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

  try {
    const { id } = await resend.sendEmail({
      from: binding.emailAddress,
      to: originalThread.externalAddress,
      subject,
      text: input.body,
      headers: { 'In-Reply-To': inReplyTo, References: references },
      attachments: input.attachments,
    });

    await recordThreadMessage(db, {
      discordMessageId: input.discordMessageId,
      bindingId: binding.id,
      externalAddress: originalThread.externalAddress,
      subject,
      emailMessageId: id,
      inReplyTo,
      referencesChain: references,
      direction: 'outbound',
    });

    return { ok: true, emailId: id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
