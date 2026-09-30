import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, createDbWithHandle } from '../../src/db/client';
import { addressBindings, gmailAccounts, oauthStates, processedGmailMessages } from '../../src/db/schema';

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

  describe('Gmail bind support', () => {
    it('defaults new address_bindings rows to provider=resend', async () => {
      const db = createDb(':memory:');
      const rows = await db
        .insert(addressBindings)
        .values({
          emailAddress: 'tako@octo.jp',
          discordGuildId: 'guild-1',
          discordChannelId: 'chan-1',
          createdBy: 'user-1',
          createdAt: new Date().toISOString(),
        })
        .returning();
      expect(rows[0].provider).toBe('resend');
    });

    it('creates the new gmail_accounts/oauth_states/processed_gmail_messages tables', async () => {
      const db = createDb(':memory:');
      expect(await db.select().from(gmailAccounts)).toEqual([]);
      expect(await db.select().from(oauthStates)).toEqual([]);
      expect(await db.select().from(processedGmailMessages)).toEqual([]);
    });

    it('re-running applySchema against an already-migrated DB file is idempotent', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'mailcord-db-test-'));
      const dbPath = join(tmp, 'mailcord.db');
      try {
        const first = createDbWithHandle(dbPath);
        first.sqlite.close();
        // A second open re-runs applySchema's CREATE TABLE IF NOT EXISTS + guarded ALTER TABLE
        // calls against a file that already has the provider/gmail_thread_id columns.
        const second = createDbWithHandle(dbPath);
        second.sqlite.close();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
