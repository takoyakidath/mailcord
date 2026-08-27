import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
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
});
