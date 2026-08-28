import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { emailThreads } from '../db/schema';

export type ThreadRecord = typeof emailThreads.$inferSelect;

export async function recordThreadMessage(
  db: Db,
  params: Omit<ThreadRecord, 'id' | 'createdAt'>,
): Promise<ThreadRecord> {
  const createdAt = new Date().toISOString();
  const rows = await db
    .insert(emailThreads)
    .values({ ...params, createdAt })
    .returning();
  return rows[0];
}

export async function resolveThreadByDiscordMessageId(
  db: Db,
  discordMessageId: string,
): Promise<ThreadRecord | null> {
  const rows = await db
    .select()
    .from(emailThreads)
    .where(eq(emailThreads.discordMessageId, discordMessageId))
    .limit(1);
  return rows[0] ?? null;
}
