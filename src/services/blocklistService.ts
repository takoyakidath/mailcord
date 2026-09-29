import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { blockedSenders } from '../db/schema';

export type BlockedSender = typeof blockedSenders.$inferSelect;

export interface BlockSenderParams {
  emailAddress: string;
  createdBy: string;
}

function normalizeAddress(emailAddress: string): string {
  return emailAddress.trim().toLowerCase();
}

export async function blockSender(db: Db, params: BlockSenderParams): Promise<BlockedSender> {
  const emailAddress = normalizeAddress(params.emailAddress);
  const existing = await db
    .select()
    .from(blockedSenders)
    .where(eq(blockedSenders.emailAddress, emailAddress))
    .limit(1);
  if (existing[0]) return existing[0];

  const createdAt = new Date().toISOString();
  const rows = await db
    .insert(blockedSenders)
    .values({ emailAddress, createdBy: params.createdBy, createdAt })
    .returning();
  return rows[0];
}

export async function unblockSender(db: Db, emailAddress: string): Promise<boolean> {
  const normalized = normalizeAddress(emailAddress);
  const existing = await db
    .select()
    .from(blockedSenders)
    .where(eq(blockedSenders.emailAddress, normalized))
    .limit(1);
  if (!existing[0]) return false;
  await db.delete(blockedSenders).where(eq(blockedSenders.emailAddress, normalized));
  return true;
}

export async function listBlockedSenders(db: Db): Promise<BlockedSender[]> {
  return db.select().from(blockedSenders);
}

export async function isSenderBlocked(db: Db, emailAddress: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(blockedSenders)
    .where(eq(blockedSenders.emailAddress, normalizeAddress(emailAddress)))
    .limit(1);
  return rows.length > 0;
}
