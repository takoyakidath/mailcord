import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { addressBindings } from '../db/schema';

export interface Binding {
  id: number;
  emailAddress: string;
  discordGuildId: string;
  discordChannelId: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateBindingParams {
  emailAddress: string;
  discordGuildId: string;
  discordChannelId: string;
  createdBy: string;
}

function normalizeAddress(emailAddress: string): string {
  return emailAddress.trim().toLowerCase();
}

export async function createBinding(db: Db, params: CreateBindingParams): Promise<Binding> {
  const createdAt = new Date().toISOString();
  // SQLite's `eq` on TEXT is case-sensitive, so store addresses in a single canonical case.
  const rows = await db
    .insert(addressBindings)
    .values({ ...params, emailAddress: normalizeAddress(params.emailAddress), createdAt })
    .returning();
  return rows[0] as Binding;
}

export async function removeBinding(db: Db, discordChannelId: string): Promise<boolean> {
  const existing = await resolveBindingByChannel(db, discordChannelId);
  if (!existing) return false;
  await db.delete(addressBindings).where(eq(addressBindings.discordChannelId, discordChannelId));
  return true;
}

export async function listBindingsForGuild(db: Db, discordGuildId: string): Promise<Binding[]> {
  const rows = await db
    .select()
    .from(addressBindings)
    .where(eq(addressBindings.discordGuildId, discordGuildId));
  return rows as Binding[];
}

export async function resolveBindingByChannel(db: Db, discordChannelId: string): Promise<Binding | null> {
  const rows = await db
    .select()
    .from(addressBindings)
    .where(eq(addressBindings.discordChannelId, discordChannelId))
    .limit(1);
  return (rows[0] as Binding) ?? null;
}

export async function resolveBindingByAddress(db: Db, emailAddress: string): Promise<Binding | null> {
  const rows = await db
    .select()
    .from(addressBindings)
    .where(eq(addressBindings.emailAddress, normalizeAddress(emailAddress)))
    .limit(1);
  return (rows[0] as Binding) ?? null;
}
