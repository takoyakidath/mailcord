import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { createBinding } from '../../src/services/bindingService';
import { recordThreadMessage, resolveThreadByDiscordMessageId } from '../../src/services/threadService';

describe('threadService', () => {
  let db: Db;
  let bindingId: number;

  beforeEach(async () => {
    db = createDb(':memory:');
    const binding = await createBinding(db, {
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });
    bindingId = binding.id;
  });

  it('records an inbound message and resolves it by Discord message id', async () => {
    await recordThreadMessage(db, {
      discordMessageId: 'discord-msg-1',
      bindingId,
      externalAddress: 'friend@example.com',
      subject: 'Hello',
      emailMessageId: '<mail1@example.com>',
      inReplyTo: null,
      referencesChain: null,
      direction: 'inbound',
    });

    const resolved = await resolveThreadByDiscordMessageId(db, 'discord-msg-1');
    expect(resolved?.externalAddress).toBe('friend@example.com');
    expect(resolved?.direction).toBe('inbound');
  });

  it('returns null when no thread matches', async () => {
    expect(await resolveThreadByDiscordMessageId(db, 'missing')).toBeNull();
  });
});
