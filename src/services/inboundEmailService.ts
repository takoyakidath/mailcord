import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { ResendClient } from '../mail/resendClient';
import { resolveBindingByAddress } from './bindingService';
import { recordThreadMessage } from './threadService';
import { isSenderBlocked } from './blocklistService';
import { classifySpam } from './spamFilter';
import { extractEmailAddress } from '../mail/address';
import { stripHtml } from '../util/stripHtml';
import { fetchAsBuffer } from '../util/fetchBuffer';
import { processedInboundEmails } from '../db/schema';

export interface DiscordAttachmentInput {
  filename: string;
  content: Buffer;
}

export interface DiscordPoster {
  postEmailMessage(
    channelId: string,
    params: {
      from: string;
      subject: string;
      bodyPreview: string;
      attachments: DiscordAttachmentInput[];
      /** Set when the mail was redirected here as blocked/suspected spam, for the embed to call out. */
      flagReason?: string;
    },
  ): Promise<{ discordMessageId: string }>;
}

const BODY_PREVIEW_MAX_LENGTH = 1800;
/** Discord's default (non-boosted) per-file upload limit. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const SKIPPED_ATTACHMENT_NOTE = '(添付は容量超過のため省略されました)';
const TRUNCATED_BODY_NOTE = '…(本文が長いため省略されました)';

/** Candidate recipient addresses, normalized so `Tako <Tako@Octo.jp>` matches `tako@octo.jp`. */
function candidateRecipients(email: { to: string[]; receivedFor?: string[] }): string[] {
  const normalized = [...email.to, ...(email.receivedFor ?? [])]
    .map((raw) => extractEmailAddress(raw).toLowerCase())
    .filter((addr) => addr.length > 0);
  return [...new Set(normalized)];
}

// Resend/Svix redeliver a webhook on timeout or a 5xx response (see web/server.ts), which would
// otherwise re-post the same email to Discord. Checked before any Resend/Discord call so a retry
// costs one cheap lookup instead of re-fetching the email and its attachments.
async function alreadyProcessed(db: Db, emailId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(processedInboundEmails)
    .where(eq(processedInboundEmails.resendEmailId, emailId))
    .limit(1);
  return rows.length > 0;
}

async function markProcessed(db: Db, emailId: string): Promise<void> {
  await db.insert(processedInboundEmails).values({ resendEmailId: emailId, createdAt: new Date().toISOString() });
}

export async function handleInboundEmail(
  db: Db,
  resend: ResendClient,
  poster: DiscordPoster,
  emailId: string,
  spamChannelId: string,
): Promise<{ handled: boolean; reason?: string; filtered?: 'blocked' | 'spam' }> {
  if (await alreadyProcessed(db, emailId)) {
    return { handled: false, reason: `email ${emailId} was already processed` };
  }

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

  // Fetch attachments concurrently, and isolate one attachment's failure (oversized or a
  // download error) from the rest — a single bad attachment must not blackhole the whole email.
  const attachmentResults = await Promise.allSettled(
    email.attachments.map(async (att) => {
      // Spec: oversized attachments are skipped and noted in the body.
      if (att.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment ${att.filename} exceeds the size limit (declared ${att.size} bytes)`);
      }
      const url = await resend.getAttachmentDownloadUrl(email.emailId, att.id);
      const content = await fetchAsBuffer(url);
      if (content.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment ${att.filename} exceeds the size limit (actual ${content.byteLength} bytes)`);
      }
      return { filename: att.filename, content };
    }),
  );

  const attachments: DiscordAttachmentInput[] = [];
  let skippedAttachment = false;
  for (const result of attachmentResults) {
    if (result.status === 'fulfilled') {
      attachments.push(result.value);
    } else {
      skippedAttachment = true;
      console.error('skipping inbound attachment:', result.reason);
    }
  }

  const rawBody = email.text || stripHtml(email.html) || '';
  const truncated = rawBody.length > BODY_PREVIEW_MAX_LENGTH;
  const notes = [truncated && TRUNCATED_BODY_NOTE, skippedAttachment && SKIPPED_ATTACHMENT_NOTE].filter(
    (note): note is string => Boolean(note),
  );
  const suffix = notes.length > 0 ? `\n\n${notes.join('\n')}` : '';
  const bodyPreview = rawBody.slice(0, BODY_PREVIEW_MAX_LENGTH - suffix.length) + suffix;

  const senderAddress = extractEmailAddress(email.from);
  const blocked = await isSenderBlocked(db, senderAddress);
  const spamCheck = blocked ? null : classifySpam({ subject: email.subject, text: rawBody });
  const filtered: 'blocked' | 'spam' | undefined = blocked ? 'blocked' : spamCheck?.isSpam ? 'spam' : undefined;

  const targetChannelId = filtered ? spamChannelId : binding.discordChannelId;
  const flagReason = blocked
    ? `ブロック済みの送信者です: ${senderAddress}`
    : spamCheck?.isSpam
      ? `迷惑メールの疑いがあります (${spamCheck.reasons.join(', ')})`
      : undefined;

  const { discordMessageId } = await poster.postEmailMessage(targetChannelId, {
    from: email.from,
    subject: email.subject,
    bodyPreview,
    attachments,
    ...(flagReason ? { flagReason } : {}),
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
    externalAddress: senderAddress,
    subject: email.subject,
    emailMessageId: messageIdHeader,
    inReplyTo: email.headers['In-Reply-To'] ?? null,
    referencesChain: email.headers['References'] ?? null,
    direction: 'inbound',
  });

  await markProcessed(db, emailId);

  return filtered ? { handled: true, filtered } : { handled: true };
}
