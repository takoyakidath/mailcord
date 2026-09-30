import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { GmailClient, GmailMessageMetadata } from '../mail/gmailClient';
import type { DiscordPoster } from './inboundEmailService';
import { processedGmailMessages } from '../db/schema';
import { listGmailAccounts, updateHistoryCursor, getLiveAccessToken, type GmailAccount } from './gmailAccountService';
import { resolveBindingById } from './bindingService';
import { recordThreadMessage } from './threadService';
import { isSenderBlocked } from './blocklistService';
import { extractEmailAddress } from '../mail/address';

// Mirrors processed_inbound_emails: if the process crashes after posting to Discord but before
// persisting the advanced historyId, the next tick must not re-post the same message.
async function alreadyProcessed(db: Db, gmailMessageId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(processedGmailMessages)
    .where(eq(processedGmailMessages.gmailMessageId, gmailMessageId))
    .limit(1);
  return rows.length > 0;
}

async function markProcessed(db: Db, gmailMessageId: string): Promise<void> {
  await db.insert(processedGmailMessages).values({ gmailMessageId, createdAt: new Date().toISOString() });
}

function gmailViewUrl(messageId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${messageId}`;
}

async function pollOneBinding(
  db: Db,
  gmail: GmailClient,
  tokenEncryptionKey: string,
  poster: DiscordPoster,
  account: GmailAccount,
): Promise<void> {
  const binding = await resolveBindingById(db, account.bindingId);
  if (!binding) return; // the binding was removed since accounts were listed; nothing to do.

  const accessToken = await getLiveAccessToken(db, gmail, tokenEncryptionKey, account);
  const history = await gmail.listHistory(accessToken, account.historyId);

  if (history.historyGone) {
    // The stored cursor fell outside Gmail's retained history window (roughly a week). We can't
    // safely reconstruct what was missed, so re-baseline from the current profile and skip
    // posting this tick — silently under-posting once is far safer than mass-reposting old mail.
    console.warn(`gmail history gone for binding ${binding.id} (${binding.emailAddress}); re-baselining`);
    const profile = await gmail.getProfile(accessToken);
    await updateHistoryCursor(db, account.id, profile.historyId);
    return;
  }

  for (const { id: gmailMessageId } of history.newMessages) {
    if (await alreadyProcessed(db, gmailMessageId)) continue;

    let metadata: GmailMessageMetadata;
    try {
      metadata = await gmail.getMessageMetadata(accessToken, gmailMessageId);
    } catch (err) {
      console.error(`failed to fetch gmail message ${gmailMessageId} for binding ${binding.id}:`, err);
      continue;
    }

    // Belt-and-suspenders alongside listHistory's own labelId=INBOX filter: our own outbound
    // Gmail sends land in SENT and must never loop back through the poller as if inbound.
    if (!metadata.labelIds.includes('INBOX')) {
      await markProcessed(db, gmailMessageId);
      continue;
    }

    const senderAddress = extractEmailAddress(metadata.from);
    if (await isSenderBlocked(db, senderAddress)) {
      await markProcessed(db, gmailMessageId);
      continue;
    }

    const { discordMessageId } = await poster.postGmailMessage(binding.discordChannelId, {
      subject: metadata.subject,
      from: metadata.from,
      viewUrl: gmailViewUrl(metadata.id),
    });

    await recordThreadMessage(db, {
      discordMessageId,
      bindingId: binding.id,
      externalAddress: senderAddress,
      subject: metadata.subject,
      emailMessageId: metadata.messageIdHeader,
      inReplyTo: metadata.inReplyTo,
      referencesChain: metadata.references,
      direction: 'inbound',
      gmailThreadId: metadata.threadId,
    });

    await markProcessed(db, gmailMessageId);
  }

  await updateHistoryCursor(db, account.id, history.newHistoryId);
}

export async function pollAllGmailBindings(
  db: Db,
  gmail: GmailClient,
  tokenEncryptionKey: string,
  poster: DiscordPoster,
): Promise<void> {
  const accounts = await listGmailAccounts(db);
  // One failing account (revoked consent, expired refresh token, transient API error) must
  // never block the others from polling — mirrors the Promise.allSettled attachment-fetch
  // isolation already used for Resend inbound.
  await Promise.allSettled(
    accounts.map((account) =>
      pollOneBinding(db, gmail, tokenEncryptionKey, poster, account).catch((err) => {
        console.error(`gmail poll failed for binding ${account.bindingId}:`, err);
      }),
    ),
  );
}
