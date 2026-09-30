import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../../src/db/client';
import { gmailAccounts } from '../../src/db/schema';
import {
  createBinding,
  removeBinding,
  listBindingsForGuild,
  resolveBindingByChannel,
  resolveBindingByAddress,
} from '../../src/services/bindingService';

describe('bindingService', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('creates and resolves a binding by channel and by address', async () => {
    await createBinding(db, {
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });

    const byChannel = await resolveBindingByChannel(db, 'chan-1');
    expect(byChannel?.emailAddress).toBe('tako@octo.jp');

    const byAddress = await resolveBindingByAddress(db, 'tako@octo.jp');
    expect(byAddress?.discordChannelId).toBe('chan-1');
  });

  it('stores and resolves addresses case-insensitively', async () => {
    const created = await createBinding(db, {
      emailAddress: 'TaKo@Octo.JP',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });

    expect(created.emailAddress).toBe('tako@octo.jp');
    expect((await resolveBindingByAddress(db, 'Tako@OCTO.jp'))?.discordChannelId).toBe('chan-1');
    expect((await resolveBindingByAddress(db, 'tako@octo.jp'))?.discordChannelId).toBe('chan-1');
  });

  it('returns null when no binding matches', async () => {
    expect(await resolveBindingByChannel(db, 'missing')).toBeNull();
    expect(await resolveBindingByAddress(db, 'missing@x.com')).toBeNull();
  });

  it('lists bindings for a guild', async () => {
    await createBinding(db, { emailAddress: 'tako@octo.jp', discordGuildId: 'guild-1', discordChannelId: 'chan-1', createdBy: 'u1' });
    await createBinding(db, { emailAddress: 'tai@octo.jp', discordGuildId: 'guild-1', discordChannelId: 'chan-2', createdBy: 'u1' });
    await createBinding(db, { emailAddress: 'other@x.com', discordGuildId: 'guild-2', discordChannelId: 'chan-3', createdBy: 'u1' });

    const list = await listBindingsForGuild(db, 'guild-1');
    expect(list).toHaveLength(2);
  });

  it('removes a binding, returning whether one existed', async () => {
    await createBinding(db, { emailAddress: 'tako@octo.jp', discordGuildId: 'guild-1', discordChannelId: 'chan-1', createdBy: 'u1' });

    expect(await removeBinding(db, 'chan-1')).toBe(true);
    expect(await resolveBindingByChannel(db, 'chan-1')).toBeNull();
    expect(await removeBinding(db, 'chan-1')).toBe(false);
  });

  it('defaults to provider=resend but accepts provider=gmail', async () => {
    const resend = await createBinding(db, { emailAddress: 'tako@octo.jp', discordGuildId: 'g1', discordChannelId: 'chan-1', createdBy: 'u1' });
    expect(resend.provider).toBe('resend');

    const gmail = await createBinding(db, {
      emailAddress: 'tako@gmail.com',
      discordGuildId: 'g1',
      discordChannelId: 'chan-2',
      createdBy: 'u1',
      provider: 'gmail',
    });
    expect(gmail.provider).toBe('gmail');
  });

  it('removing a gmail binding also deletes its gmail_accounts row', async () => {
    const binding = await createBinding(db, {
      emailAddress: 'tako@gmail.com',
      discordGuildId: 'g1',
      discordChannelId: 'chan-1',
      createdBy: 'u1',
      provider: 'gmail',
    });
    await db.insert(gmailAccounts).values({
      bindingId: binding.id,
      encryptedRefreshToken: 'enc-refresh',
      historyId: '1',
      createdAt: new Date().toISOString(),
    });

    expect(await removeBinding(db, 'chan-1')).toBe(true);
    expect(await db.select().from(gmailAccounts).where(eq(gmailAccounts.bindingId, binding.id))).toEqual([]);
  });
});
