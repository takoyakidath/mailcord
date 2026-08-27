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
/** Discord's default (non-boosted) per-file upload limit. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const SKIPPED_ATTACHMENT_NOTE = '\n\n(添付は容量超過のため省略されました)';

/** Candidate recipient addresses, normalized so `Tako <Tako@Octo.jp>` matches `tako@octo.jp`. */
function candidateRecipients(email: { to: string[]; receivedFor?: string[] }): string[] {
  const normalized = [...email.to, ...(email.receivedFor ?? [])]
    .map((raw) => extractEmailAddress(raw).toLowerCase())
    .filter((addr) => addr.length > 0);
  return [...new Set(normalized)];
}

export async function handleInboundEmail(
  db: Db,
  resend: ResendClient,
  poster: DiscordPoster,
  emailId: string,
): Promise<{ handled: boolean; reason?: string }> {
  const email = await resend.getReceivedEmail(emailId);

  const recipients = candidateRecipients(email);
  let binding = null;
  for (const address of recipients) {
    binding = await resolveBindingByAddress(db, address);
    if (binding) break;
  }
  if (!binding) {
    return { handled: false, reason: `no binding for recipients: ${recipients.join(', ')}` };
  }

  const attachments: DiscordAttachmentInput[] = [];
  let skippedAttachment = false;
  for (const att of email.attachments) {
    // Spec: oversized attachments are skipped and noted in the body.
    if (att.size > MAX_ATTACHMENT_BYTES) {
      skippedAttachment = true;
      continue;
    }
    const url = await resend.getAttachmentDownloadUrl(email.emailId, att.id);
    const content = await fetchAsBuffer(url);
    if (content.byteLength > MAX_ATTACHMENT_BYTES) {
      skippedAttachment = true;
      continue;
    }
    attachments.push({ filename: att.filename, content });
  }

  const rawBody = email.text || stripHtml(email.html) || '';
  let bodyPreview = rawBody.slice(0, BODY_PREVIEW_MAX_LENGTH);
  if (skippedAttachment) {
    bodyPreview = bodyPreview.slice(0, BODY_PREVIEW_MAX_LENGTH - SKIPPED_ATTACHMENT_NOTE.length) + SKIPPED_ATTACHMENT_NOTE;
  }

  const { discordMessageId } = await poster.postEmailMessage(binding.discordChannelId, {
    from: email.from,
    subject: email.subject,
    bodyPreview,
    attachments,
  });

  // The SDK exposes the real Message-ID as a first-class field; header casing is only a fallback.
  const messageIdHeader =
    email.messageId ||
    email.headers['Message-Id'] ||
    email.headers['Message-ID'] ||
    email.headers['message-id'] ||
    emailId;

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
