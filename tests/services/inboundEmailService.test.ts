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

  it('prefers the SDK message_id over the header lookup', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-mid',
        from: 'friend@example.com',
        to: ['tako@octo.jp'],
        receivedFor: [],
        messageId: '<sdk-field@x>',
        subject: 'Hello',
        text: 'Body',
        html: '',
        headers: { 'Message-Id': '<header@x>' },
        attachments: [],
      }),
    });

    await handleInboundEmail(db, resend, poster, 'email-mid');

    const thread = await resolveThreadByDiscordMessageId(db, 'discord-msg-1');
    expect(thread?.emailMessageId).toBe('<sdk-field@x>');
  });

  it('matches a recipient regardless of case', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-case',
        from: 'friend@example.com',
        to: ['Tako@Octo.JP'],
        receivedFor: [],
        messageId: '<case@x>',
        subject: 'Hello',
        text: 'Body',
        html: '',
        headers: {},
        attachments: [],
      }),
    });

    const result = await handleInboundEmail(db, resend, poster, 'email-case');
    expect(result.handled).toBe(true);
    expect(poster.postEmailMessage).toHaveBeenCalledWith('chan-1', expect.anything());
  });

  it('matches a "Name <addr>"-formatted recipient', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-display',
        from: 'friend@example.com',
        to: ['Tako Yaki <tako@octo.jp>'],
        receivedFor: [],
        messageId: '<display@x>',
        subject: 'Hello',
        text: 'Body',
        html: '',
        headers: {},
        attachments: [],
      }),
    });

    const result = await handleInboundEmail(db, resend, poster, 'email-display');
    expect(result.handled).toBe(true);
  });

  it('matches via received_for when the To header does not name the bound address', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-bcc',
        from: 'friend@example.com',
        to: ['list@elsewhere.example'],
        receivedFor: ['tako@octo.jp'],
        messageId: '<bcc@x>',
        subject: 'Hello',
        text: 'Body',
        html: '',
        headers: {},
        attachments: [],
      }),
    });

    const result = await handleInboundEmail(db, resend, poster, 'email-bcc');
    expect(result.handled).toBe(true);
  });

  it('skips an oversized attachment and notes it in the body preview', async () => {
    const resend = fakeResend({
      getReceivedEmail: vi.fn().mockResolvedValue({
        emailId: 'email-big',
        from: 'friend@example.com',
        to: ['tako@octo.jp'],
        receivedFor: [],
        messageId: '<big@x>',
        subject: 'Hello',
        text: 'Body text',
        html: '',
        headers: {},
        attachments: [
          { id: 'att-big', filename: 'huge.zip', contentType: 'application/zip', size: 25 * 1024 * 1024 },
          { id: 'att-ok', filename: 'a.pdf', contentType: 'application/pdf', size: 10 },
        ],
      }),
    });

    await handleInboundEmail(db, resend, poster, 'email-big');

    expect(resend.getAttachmentDownloadUrl).toHaveBeenCalledTimes(1);
    expect(poster.postEmailMessage).toHaveBeenCalledWith('chan-1', expect.objectContaining({
      attachments: [{ filename: 'a.pdf', content: Buffer.from('file-bytes') }],
      bodyPreview: 'Body text\n\n(添付は容量超過のため省略されました)',
    }));
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
