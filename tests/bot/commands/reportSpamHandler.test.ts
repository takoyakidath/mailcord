import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../../src/db/client';
import { createBinding } from '../../../src/services/bindingService';
import { recordThreadMessage } from '../../../src/services/threadService';
import { isSenderBlocked } from '../../../src/services/blocklistService';
import { handleReportSpamCommand } from '../../../src/bot/commands/reportSpamHandler';

describe('handleReportSpamCommand', () => {
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

  async function recordThread(discordMessageId: string, direction: 'inbound' | 'outbound') {
    await recordThreadMessage(db, {
      discordMessageId,
      bindingId,
      externalAddress: 'spammer@example.com',
      subject: 'Hello',
      emailMessageId: `<${discordMessageId}@x>`,
      inReplyTo: null,
      referencesChain: null,
      direction,
      gmailThreadId: null,
    });
  }

  it('blocks the sender of a reported inbound mail message', async () => {
    await recordThread('msg-in', 'inbound');

    const result = await handleReportSpamCommand(db, { discordMessageId: 'msg-in', requestedBy: 'user-2' });

    expect(result).toMatchObject({ ok: true, emailAddress: 'spammer@example.com' });
    expect(result.replyText).toContain('spammer@example.com');
    expect(await isSenderBlocked(db, 'spammer@example.com')).toBe(true);
  });

  it('rejects a message that is not a received mail', async () => {
    const result = await handleReportSpamCommand(db, { discordMessageId: 'unknown', requestedBy: 'user-2' });

    expect(result.ok).toBe(false);
    expect(await isSenderBlocked(db, 'spammer@example.com')).toBe(false);
  });

  it('rejects our own outbound mail', async () => {
    await recordThread('msg-out', 'outbound');

    const result = await handleReportSpamCommand(db, { discordMessageId: 'msg-out', requestedBy: 'user-2' });

    expect(result.ok).toBe(false);
    expect(await isSenderBlocked(db, 'spammer@example.com')).toBe(false);
  });
});
