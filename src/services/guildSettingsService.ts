import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { guildSettings } from '../db/schema';

export async function getSpamChannelId(db: Db, guildId: string): Promise<string | null> {
  const rows = await db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).limit(1);
  return rows[0]?.spamChannelId ?? null;
}

export async function setSpamChannelId(db: Db, guildId: string, channelId: string | null, updatedBy: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  await db
    .insert(guildSettings)
    .values({ guildId, spamChannelId: channelId, updatedBy, updatedAt })
    .onConflictDoUpdate({ target: guildSettings.guildId, set: { spamChannelId: channelId, updatedBy, updatedAt } });
}

/**
 * Where blocked/spam mail for a guild goes: the guild's own setting, else the env-level fallback
 * (SPAM_CHANNEL_ID), else null — in which case callers leave the mail in its normal channel.
 */
export async function resolveSpamChannelId(db: Db, guildId: string, fallback: string | undefined): Promise<string | null> {
  return (await getSpamChannelId(db, guildId)) ?? fallback ?? null;
}
