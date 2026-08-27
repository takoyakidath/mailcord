import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/db/client';
import { addressBindings } from '../../src/db/schema';

describe('createDb', () => {
  it('creates tables and allows insert/read round-trip', async () => {
    const db = createDb(':memory:');
    await db.insert(addressBindings).values({
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
      createdAt: new Date().toISOString(),
    });
    const rows = await db.select().from(addressBindings);
    expect(rows).toHaveLength(1);
    expect(rows[0].emailAddress).toBe('tako@octo.jp');
  });
});
