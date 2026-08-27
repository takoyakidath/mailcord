import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

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
}

export function createDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  applySchema(sqlite);
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
