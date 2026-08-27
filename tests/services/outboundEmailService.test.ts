import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { createBinding } from '../../src/services/bindingService';
import { recordThreadMessage, resolveThreadByDiscordMessageId } from '../../src/services/threadService';
import { sendNewEmail, sendReplyEmail } from '../../src/services/outboundEmailService';
import type { ResendClient } from '../../src/mail/resendClient';

function fakeResend(overrides: Partial<ResendClient> = {}): ResendClient {
  return {
    sendEmail: vi.fn().mockResolvedValue({ id: '<sent@x>' }),
    getReceivedEmail: vi.fn(),
    getAttachmentDownloadUrl: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    ...overrides,
  };
}

describe('outboundEmailService', () => {
  let db: Db;

  beforeEach(async () => {
    db = createDb(':memory:');
    await createBinding(db, {
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });
  });

  describe('sendNewEmail', () => {
    it('sends via Resend and records an outbound thread row', async () => {
      const resend = fakeResend();
      const result = await sendNewEmail(db, resend, {
        discordChannelId: 'chan-1',
        discordMessageId: 'discord-msg-1',
        to: 'friend@example.com',
        subject: 'Hi',
        body: 'Hello there',
      });

      expect(result).toEqual({ ok: true, emailId: '<sent@x>' });
      expect(resend.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
        from: 'tako@octo.jp',
        to: 'friend@example.com',
        subject: 'Hi',
        text: 'Hello there',
      }));

      const thread = await resolveThreadByDiscordMessageId(db, 'discord-msg-1');
      expect(thread?.direction).toBe('outbound');
      expect(thread?.externalAddress).toBe('friend@example.com');
    });

    it('fails when the channel has no binding', async () => {
      const resend = fakeResend();
      const result = await sendNewEmail(db, resend, {
        discordChannelId: 'unbound-chan',
        discordMessageId: 'discord-msg-2',
        to: 'friend@example.com',
        subject: 'Hi',
        body: 'Hello',
      });
      expect(result.ok).toBe(false);
      expect(resend.sendEmail).not.toHaveBeenCalled();
    });

    it('returns an error result when Resend throws', async () => {
      const resend = fakeResend({ sendEmail: vi.fn().mockRejectedValue(new Error('rate limited')) });
      const result = await sendNewEmail(db, resend, {
        discordChannelId: 'chan-1',
        discordMessageId: 'discord-msg-3',
        to: 'friend@example.com',
        subject: 'Hi',
        body: 'Hello',
      });
      expect(result).toEqual({ ok: false, error: 'rate limited' });
    });
  });

  describe('sendReplyEmail', () => {
    it('resolves the original thread, sets reply headers, and records a new row', async () => {
      const binding = await createBinding(db, {
        emailAddress: 'tai@octo.jp',
        discordGuildId: 'guild-1',
        discordChannelId: 'chan-2',
        createdBy: 'user-1',
      });
      await recordThreadMessage(db, {
        discordMessageId: 'inbound-msg-1',
        bindingId: binding.id,
        externalAddress: 'friend@example.com',
        subject: 'Original subject',
        emailMessageId: '<orig@x>',
        inReplyTo: null,
        referencesChain: null,
        direction: 'inbound',
      });

      const resend = fakeResend();
      const result = await sendReplyEmail(db, resend, {
        discordChannelId: 'chan-2',
        discordMessageId: 'discord-reply-1',
        repliedToDiscordMessageId: 'inbound-msg-1',
        body: 'Thanks!',
      });

      expect(result).toEqual({ ok: true, emailId: '<sent@x>' });
      expect(resend.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
        from: 'tai@octo.jp',
        to: 'friend@example.com',
        subject: 'Re: Original subject',
        text: 'Thanks!',
        headers: { 'In-Reply-To': '<orig@x>', References: '<orig@x>' },
      }));

      const newThread = await resolveThreadByDiscordMessageId(db, 'discord-reply-1');
      expect(newThread?.referencesChain).toBe('<orig@x>');
    });

    it('fails when the replied-to message has no known thread', async () => {
      const resend = fakeResend();
      const result = await sendReplyEmail(db, resend, {
        discordChannelId: 'chan-1',
        discordMessageId: 'discord-reply-2',
        repliedToDiscordMessageId: 'unknown-msg',
        body: 'Thanks!',
      });
      expect(result.ok).toBe(false);
      expect(resend.sendEmail).not.toHaveBeenCalled();
    });
  });
});
