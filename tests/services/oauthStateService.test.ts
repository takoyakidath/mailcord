import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { oauthStates } from '../../src/db/schema';
import { createOauthState, consumeOauthState } from '../../src/services/oauthStateService';

describe('oauthStateService', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('creates then consumes a state row exactly once', async () => {
    const state = await createOauthState(db, { discordGuildId: 'g1', discordChannelId: 'c1', requestedBy: 'u1' });

    const consumed = await consumeOauthState(db, state);
    expect(consumed?.discordChannelId).toBe('c1');
    expect(consumed?.requestedBy).toBe('u1');

    // Replaying the same state must fail — it was deleted on first use.
    expect(await consumeOauthState(db, state)).toBeNull();
  });

  it('returns null for an unknown state', async () => {
    expect(await consumeOauthState(db, 'never-issued')).toBeNull();
  });

  it('rejects and sweeps an expired state', async () => {
    await db.insert(oauthStates).values({
      state: 'expired-state',
      discordGuildId: 'g1',
      discordChannelId: 'c1',
      requestedBy: 'u1',
      createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    expect(await consumeOauthState(db, 'expired-state')).toBeNull();
    expect(await db.select().from(oauthStates)).toEqual([]);
  });

  it('sweeps other expired rows as a side effect of consuming an unrelated state', async () => {
    await db.insert(oauthStates).values({
      state: 'stale',
      discordGuildId: 'g1',
      discordChannelId: 'c1',
      requestedBy: 'u1',
      createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    const freshState = await createOauthState(db, { discordGuildId: 'g2', discordChannelId: 'c2', requestedBy: 'u2' });

    await consumeOauthState(db, freshState);

    const remaining = await db.select().from(oauthStates);
    expect(remaining.find((r) => r.state === 'stale')).toBeUndefined();
  });
});
