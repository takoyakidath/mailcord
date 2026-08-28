import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, createDbWithHandle } from '../../src/db/client';
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

  describe('with a file path in a directory that does not exist yet', () => {
    let tmpRoot: string;

    afterEach(() => {
      if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('creates the parent directory instead of throwing SQLITE_CANTOPEN', async () => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'mailcord-db-test-'));
      const dbPath = join(tmpRoot, 'nested', 'dir', 'mailcord.db');
      expect(existsSync(dbPath)).toBe(false);

      const { sqlite } = createDbWithHandle(dbPath);
      expect(existsSync(dbPath)).toBe(true);
      sqlite.close();
    });
  });
});
