import { randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { oauthStates } from '../db/schema';

export type OauthState = typeof oauthStates.$inferSelect;

const STATE_TTL_MS = 10 * 60 * 1000;

export interface CreateOauthStateParams {
  discordGuildId: string;
  discordChannelId: string;
  requestedBy: string;
}

export async function createOauthState(db: Db, params: CreateOauthStateParams): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.insert(oauthStates).values({
    state,
    ...params,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + STATE_TTL_MS).toISOString(),
  });
  return state;
}

// One-time use: the matched row is deleted on first lookup regardless of outcome, so a callback
// URL can never be replayed. Also opportunistically sweeps other expired rows on every call,
// since this project has no cron to do that separately (mirrors the OAuth callback route's
// "no scheduled jobs, piggyback on the next relevant request" convention used elsewhere here).
export async function consumeOauthState(db: Db, state: string): Promise<OauthState | null> {
  const nowIso = new Date().toISOString();
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, nowIso));

  const rows = await db.select().from(oauthStates).where(eq(oauthStates.state, state)).limit(1);
  const row = rows[0];
  if (!row) return null;

  await db.delete(oauthStates).where(eq(oauthStates.state, state));
  return row;
}
