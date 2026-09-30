import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { gmailAccounts } from '../db/schema';
import type { GmailClient } from '../mail/gmailClient';

export type GmailAccount = typeof gmailAccounts.$inferSelect;

// Refresh proactively if the cached access token has less than this much life left, so a send
// or poll never races an about-to-expire token.
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

function keyFromHex(hexKey: string): Buffer {
  return Buffer.from(hexKey, 'hex');
}

// Refresh/access tokens grant standing access to someone's personal inbox, so they're encrypted
// at rest (AES-256-GCM) rather than stored as plain text like the rest of this app's data.
// Stored as base64(iv[12] || authTag[16] || ciphertext).
export function encryptToken(plaintext: string, hexKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromHex(hexKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptToken(encoded: string, hexKey: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyFromHex(hexKey), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export interface CreateGmailAccountParams {
  bindingId: number;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  historyId: string;
}

export async function createGmailAccount(
  db: Db,
  encryptionKey: string,
  params: CreateGmailAccountParams,
): Promise<GmailAccount> {
  const createdAt = new Date().toISOString();
  const rows = await db
    .insert(gmailAccounts)
    .values({
      bindingId: params.bindingId,
      encryptedRefreshToken: encryptToken(params.refreshToken, encryptionKey),
      encryptedAccessToken: encryptToken(params.accessToken, encryptionKey),
      accessTokenExpiresAt: params.accessTokenExpiresAt.toISOString(),
      historyId: params.historyId,
      createdAt,
    })
    .returning();
  return rows[0];
}

export async function getGmailAccountByBindingId(db: Db, bindingId: number): Promise<GmailAccount | null> {
  const rows = await db.select().from(gmailAccounts).where(eq(gmailAccounts.bindingId, bindingId)).limit(1);
  return rows[0] ?? null;
}

export async function listGmailAccounts(db: Db): Promise<GmailAccount[]> {
  return db.select().from(gmailAccounts);
}

export async function updateHistoryCursor(db: Db, accountId: number, historyId: string): Promise<void> {
  await db
    .update(gmailAccounts)
    .set({ historyId, lastPolledAt: new Date().toISOString() })
    .where(eq(gmailAccounts.id, accountId));
}

// The one place both outbound send and the polling loop get a usable access token from: returns
// the cached token if it still has enough life left, otherwise refreshes via the refresh token
// and persists the new one before returning it.
export async function getLiveAccessToken(
  db: Db,
  gmail: GmailClient,
  encryptionKey: string,
  account: GmailAccount,
): Promise<string> {
  if (account.encryptedAccessToken && account.accessTokenExpiresAt) {
    const expiresAt = new Date(account.accessTokenExpiresAt).getTime();
    if (expiresAt > Date.now() + ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      return decryptToken(account.encryptedAccessToken, encryptionKey);
    }
  }

  const refreshToken = decryptToken(account.encryptedRefreshToken, encryptionKey);
  const { accessToken, expiresAt } = await gmail.refreshAccessToken(refreshToken);
  await db
    .update(gmailAccounts)
    .set({ encryptedAccessToken: encryptToken(accessToken, encryptionKey), accessTokenExpiresAt: expiresAt.toISOString() })
    .where(eq(gmailAccounts.id, account.id));
  return accessToken;
}
