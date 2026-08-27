import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../../src/db/client';
import { handleBindCommand, handleUnbindCommand, handleListCommand } from '../../../src/bot/commands/bindHandler';

describe('bind/unbind/list command handlers', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('binds a channel to an address', async () => {
    const result = await handleBindCommand(db, {
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      emailAddress: 'tako@octo.jp',
      requestedBy: 'user-1',
    });
    expect(result.replyText).toContain('tako@octo.jp');
  });

  it('rebinding a channel replaces the previous binding', async () => {
    await handleBindCommand(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', emailAddress: 'tako@octo.jp', requestedBy: 'u1' });
    await handleBindCommand(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', emailAddress: 'tai@octo.jp', requestedBy: 'u1' });

    const list = await handleListCommand(db, { discordGuildId: 'g1' });
    expect(list.replyText).toContain('tai@octo.jp');
    expect(list.replyText).not.toContain('tako@octo.jp');
  });

  it('refuses to bind an address that another channel already owns', async () => {
    await handleBindCommand(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', emailAddress: 'tako@octo.jp', requestedBy: 'u1' });

    const result = await handleBindCommand(db, {
      discordGuildId: 'g1',
      discordChannelId: 'chan-2',
      emailAddress: 'tako@octo.jp',
      requestedBy: 'u2',
    });

    expect(result.replyText).toContain('既に');
    expect(result.replyText).toContain('chan-1');

    // The original binding is untouched and no duplicate row was created.
    const list = await handleListCommand(db, { discordGuildId: 'g1' });
    expect(list.replyText).toBe('<#chan-1> ⇔ `tako@octo.jp`');
  });

  it('rebinding the same channel to the same address still succeeds', async () => {
    await handleBindCommand(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', emailAddress: 'tako@octo.jp', requestedBy: 'u1' });
    const again = await handleBindCommand(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', emailAddress: 'TAKO@octo.jp', requestedBy: 'u1' });

    expect(again.replyText).toContain('バインドしました');
    const list = await handleListCommand(db, { discordGuildId: 'g1' });
    expect(list.replyText).toBe('<#chan-1> ⇔ `tako@octo.jp`');
  });

  it('unbind reports whether a binding existed', async () => {
    const notBound = await handleUnbindCommand(db, { discordChannelId: 'chan-1' });
    expect(notBound.replyText).toContain('バインドされていません');

    await handleBindCommand(db, { discordGuildId: 'g1', discordChannelId: 'chan-1', emailAddress: 'tako@octo.jp', requestedBy: 'u1' });
    const bound = await handleUnbindCommand(db, { discordChannelId: 'chan-1' });
    expect(bound.replyText).toContain('解除');
  });

  it('list reports when there are no bindings', async () => {
    const result = await handleListCommand(db, { discordGuildId: 'empty-guild' });
    expect(result.replyText).toContain('ありません');
  });
});
