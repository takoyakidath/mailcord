import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { getSpamChannelId, setSpamChannelId, resolveSpamChannelId } from '../../src/services/guildSettingsService';

describe('guildSettingsService', () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('is null until a spam channel is set', async () => {
    expect(await getSpamChannelId(db, 'g1')).toBeNull();
  });

  it('sets, overwrites and clears per guild', async () => {
    await setSpamChannelId(db, 'g1', 'c1', 'u1');
    await setSpamChannelId(db, 'g2', 'c9', 'u1');
    expect(await getSpamChannelId(db, 'g1')).toBe('c1');
    await setSpamChannelId(db, 'g1', 'c2', 'u1');
    expect(await getSpamChannelId(db, 'g1')).toBe('c2');
    expect(await getSpamChannelId(db, 'g2')).toBe('c9');
    await setSpamChannelId(db, 'g1', null, 'u1');
    expect(await getSpamChannelId(db, 'g1')).toBeNull();
  });

  it('resolves guild setting, then fallback, then null', async () => {
    expect(await resolveSpamChannelId(db, 'g1', undefined)).toBeNull();
    expect(await resolveSpamChannelId(db, 'g1', 'env-chan')).toBe('env-chan');
    await setSpamChannelId(db, 'g1', 'c1', 'u1');
    expect(await resolveSpamChannelId(db, 'g1', 'env-chan')).toBe('c1');
  });
});
