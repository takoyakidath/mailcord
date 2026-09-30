import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { addressBindings, gmailAccounts } from '../db/schema';

export type Binding = typeof addressBindings.$inferSelect;

export interface CreateBindingParams {
  emailAddress: string;
  discordGuildId: string;
  discordChannelId: string;
  createdBy: string;
  provider?: 'resend' | 'gmail';
}

function normalizeAddress(emailAddress: string): string {
  return emailAddress.trim().toLowerCase();
}

export async function createBinding(db: Db, params: CreateBindingParams): Promise<Binding> {
  const createdAt = new Date().toISOString();
  // SQLite's `eq` on TEXT is case-sensitive, so store addresses in a single canonical case.
  const rows = await db
    .insert(addressBindings)
    .values({
      ...params,
      emailAddress: normalizeAddress(params.emailAddress),
      provider: params.provider ?? 'resend',
      createdAt,
    })
    .returning();
  return rows[0];
}

export async function removeBinding(db: Db, discordChannelId: string): Promise<boolean> {
  const existing = await resolveBindingByChannel(db, discordChannelId);
  if (!existing) return false;
  // No-op for a Resend binding; for a Gmail binding this drops its OAuth tokens so the next
  // polling tick simply stops seeing this binding (no separate "stop polling" signal needed).
  await db.delete(gmailAccounts).where(eq(gmailAccounts.bindingId, existing.id));
  await db.delete(addressBindings).where(eq(addressBindings.discordChannelId, discordChannelId));
  return true;
}

export async function listBindingsForGuild(db: Db, discordGuildId: string): Promise<Binding[]> {
  return db
    .select()
    .from(addressBindings)
    .where(eq(addressBindings.discordGuildId, discordGuildId));
}

export async function resolveBindingByChannel(db: Db, discordChannelId: string): Promise<Binding | null> {
  const rows = await db
    .select()
    .from(addressBindings)
    .where(eq(addressBindings.discordChannelId, discordChannelId))
    .limit(1);
  return rows[0] ?? null;
}

export async function resolveBindingByAddress(db: Db, emailAddress: string): Promise<Binding | null> {
  const rows = await db
    .select()
    .from(addressBindings)
    .where(eq(addressBindings.emailAddress, normalizeAddress(emailAddress)))
    .limit(1);
  return rows[0] ?? null;
}

export async function resolveBindingById(db: Db, id: number): Promise<Binding | null> {
  const rows = await db.select().from(addressBindings).where(eq(addressBindings.id, id)).limit(1);
  return rows[0] ?? null;
}
