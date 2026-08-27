import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { createBinding } from '../../src/services/bindingService';
import { resolveThreadByDiscordMessageId } from '../../src/services/threadService';
import { handleInboundEmail, type DiscordPoster } from '../../src/services/inboundEmailService';
import type { ResendClient } from '../../src/mail/resendClient';

vi.mock('../../src/util/fetchBuffer', () => ({
  fetchAsBuffer: vi.fn().mockResolvedValue(Buffer.from('file-bytes')),
}));

function fakeResend(overrides: Partial<ResendClient> = {}): ResendClient {
  return {
    sendEmail: vi.fn(),
    getReceivedEmail: vi.fn(),
    getAttachmentDownloadUrl: vi.fn().mockResolvedValue('https://download/att-1'),
    verifyWebhookSignature: vi.fn(),
    ...overrides,
  };
}

describe('handleInboundEmail', () => {
  let db: Db;
  let poster: DiscordPoster;

  beforeEach(async () => {
    db = createDb(':memory:');
    await createBinding(db, {
      emailAddress: 'tako@octo.jp',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-1',
      createdBy: 'user-1',
    });
    poster = { postEmailMessage: vi.fn().mockResolvedValue({ discordMessageId: 'discord-msg-1' }) };
  });

  it('posts to the bound channel and records the thread', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-1',
        from: 'Friend <friend@example.com>',
        to: ['tako@octo.jp'],
        subject: 'Hello',
        text: 'Body text',
        html: '<p>Body text</p>',
        headers: { 'Message-Id': '<orig@x>' },
        attachments: [{ id: 'att-1', filename: 'a.pdf', contentType: 'application/pdf', size: 10 }],
      }),
    });

    const result = await handleInboundEmail(db, resend, poster, 'email-1');

    expect(result.handled).toBe(true);
    expect(poster.postEmailMessage).toHaveBeenCalledWith('chan-1', expect.objectContaining({
      from: 'Friend <friend@example.com>',
      subject: 'Hello',
      bodyPreview: 'Body text',
      attachments: [{ filename: 'a.pdf', content: Buffer.from('file-bytes') }],
    }));

    const thread = await resolveThreadByDiscordMessageId(db, 'discord-msg-1');
    expect(thread?.externalAddress).toBe('friend@example.com');
    expect(thread?.emailMessageId).toBe('<orig@x>');
    expect(thread?.direction).toBe('inbound');
  });

  it('falls back to a stripped HTML preview when text is empty', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-2',
        from: 'friend@example.com',
        to: ['tako@octo.jp'],
        subject: 'Hello',
        text: '',
        html: '<p>HTML only</p>',
        headers: { 'Message-Id': '<orig2@x>' },
        attachments: [],
      }),
    });

    await handleInboundEmail(db, resend, poster, 'email-2');

    expect(poster.postEmailMessage).toHaveBeenCalledWith('chan-1', expect.objectContaining({
      bodyPreview: 'HTML only',
    }));
  });

  it('reports unhandled when no binding matches any recipient', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-3',
        from: 'friend@example.com',
        to: ['unbound@octo.jp'],
        subject: 'Hello',
        text: 'Body',
        html: '',
        headers: {},
        attachments: [],
      }),
    });

    const result = await handleInboundEmail(db, resend, poster, 'email-3');
    expect(result.handled).toBe(false);
    expect(poster.postEmailMessage).not.toHaveBeenCalled();
  });
});
