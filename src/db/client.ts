import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

// SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and `CREATE TABLE IF NOT EXISTS` is a
// no-op against columns added to an already-existing table on a deployed DB file. This pair is
// this project's only "migration" primitive (no drizzle-kit runner) for evolving an existing table.
function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
}

function addColumnIfMissing(sqlite: Database.Database, table: string, columnName: string, columnDef: string): void {
  if (!columnExists(sqlite, table, columnName)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  }
}

function applySchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS address_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_address TEXT NOT NULL UNIQUE,
      discord_guild_id TEXT NOT NULL,
      discord_channel_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_inbound_emails (
      resend_email_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blocked_senders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_address TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_message_id TEXT NOT NULL UNIQUE,
      binding_id INTEGER NOT NULL REFERENCES address_bindings(id),
      external_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      email_message_id TEXT NOT NULL,
      in_reply_to TEXT,
      references_chain TEXT,
      direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
      created_at TEXT NOT NULL
    );
  `);

  addColumnIfMissing(
    sqlite,
    'address_bindings',
    'provider',
    `provider TEXT NOT NULL DEFAULT 'resend' CHECK (provider IN ('resend','gmail'))`,
  );
  addColumnIfMissing(sqlite, 'email_threads', 'gmail_thread_id', 'gmail_thread_id TEXT');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gmail_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      binding_id INTEGER NOT NULL UNIQUE REFERENCES address_bindings(id),
      encrypted_refresh_token TEXT NOT NULL,
      encrypted_access_token TEXT,
      access_token_expires_at TEXT,
      history_id TEXT NOT NULL,
      last_polled_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      discord_guild_id TEXT NOT NULL,
      discord_channel_id TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_gmail_messages (
      gmail_message_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `);
}

// A fresh clone's `data/` directory doesn't exist yet (it's gitignored); Docker's VOLUME
// mount creates it for us, but a local `npm run dev` needs it created explicitly.
function ensureParentDirectory(path: string): void {
  if (path === ':memory:') return;
  mkdirSync(dirname(path), { recursive: true });
}

/** Returns both the query interface and the raw handle, for callers that need to close it. */
export function createDbWithHandle(path: string): { db: ReturnType<typeof drizzle<typeof schema>>; sqlite: Database.Database } {
  ensureParentDirectory(path);
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  applySchema(sqlite);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

export function createDb(path: string) {
  return createDbWithHandle(path).db;
}

export type Db = ReturnType<typeof createDb>;
