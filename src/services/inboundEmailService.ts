import type { Db } from '../db/client';
import type { ResendClient } from '../mail/resendClient';
import { resolveBindingByAddress } from './bindingService';
import { recordThreadMessage } from './threadService';
import { extractEmailAddress } from '../mail/address';
import { stripHtml } from '../util/stripHtml';
import { fetchAsBuffer } from '../util/fetchBuffer';

export interface DiscordAttachmentInput {
  filename: string;
  content: Buffer;
}

export interface DiscordPoster {
  postEmailMessage(
    channelId: string,
    params: { from: string; subject: string; bodyPreview: string; attachments: DiscordAttachmentInput[] },
  ): Promise<{ discordMessageId: string }>;
}

const BODY_PREVIEW_MAX_LENGTH = 1800;

export async function handleInboundEmail(
  db: Db,
  resend: ResendClient,
  poster: DiscordPoster,
  emailId: string,
): Promise<{ handled: boolean; reason?: string }> {
  const email = await resend.getReceivedEmail(emailId);

  let binding = null;
  for (const address of email.to) {
    binding = await resolveBindingByAddress(db, address);
    if (binding) break;
  }
  if (!binding) {
    return { handled: false, reason: `no binding for recipients: ${email.to.join(', ')}` };
  }

  const attachments: DiscordAttachmentInput[] = [];
  for (const att of email.attachments) {
    const url = await resend.getAttachmentDownloadUrl(email.emailId, att.id);
    const content = await fetchAsBuffer(url);
    attachments.push({ filename: att.filename, content });
  }

  const rawBody = email.text || stripHtml(email.html) || '';
  const bodyPreview = rawBody.slice(0, BODY_PREVIEW_MAX_LENGTH);

  const { discordMessageId } = await poster.postEmailMessage(binding.discordChannelId, {
    from: email.from,
    subject: email.subject,
    bodyPreview,
    attachments,
  });

  const messageIdHeader =
    email.headers['Message-Id'] ?? email.headers['Message-ID'] ?? email.headers['message-id'] ?? emailId;

  await recordThreadMessage(db, {
    discordMessageId,
    bindingId: binding.id,
    externalAddress: extractEmailAddress(email.from),
    subject: email.subject,
    emailMessageId: messageIdHeader,
    inReplyTo: email.headers['In-Reply-To'] ?? null,
    referencesChain: email.headers['References'] ?? null,
    direction: 'inbound',
  });

  return { handled: true };
}
