import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, type Db } from '../../../src/db/client';
import { createBinding } from '../../../src/services/bindingService';
import { handleSendCommand } from '../../../src/bot/commands/sendHandler';
import type { ResendClient } from '../../../src/mail/resendClient';

describe('handleSendCommand', () => {
  let db: Db;

  beforeEach(async () => {
    db = createDb(':memory:');
    await createBinding(db, { emailAddress: 'tako@octo.jp', discordGuildId: 'g1', discordChannelId: 'chan-1', createdBy: 'u1' });
  });

  it('reports success when the send succeeds', async () => {
    const resend = { sendEmail: vi.fn().mockResolvedValue({ id: '<x@y>' }) } as unknown as ResendClient;
    const result = await handleSendCommand(db, { resend, gmail: null }, {
      discordChannelId: 'chan-1',
      discordMessageId: 'discord-msg-1',
      to: 'friend@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    expect(result.replyText).toContain('friend@example.com');
  });

  it('reports the error when the send fails', async () => {
    const resend = { sendEmail: vi.fn().mockRejectedValue(new Error('rate limited')) } as unknown as ResendClient;
    const result = await handleSendCommand(db, { resend, gmail: null }, {
      discordChannelId: 'chan-1',
      discordMessageId: 'discord-msg-2',
      to: 'friend@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    expect(result.replyText).toContain('rate limited');
  });
});
