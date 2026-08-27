import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();
const receivingGetMock = vi.fn();
const attachmentsGetMock = vi.fn();
const webhooksVerifyMock = vi.fn();

vi.mock('resend', () => {
  return {
    Resend: vi.fn().mockImplementation(() => ({
      emails: {
        send: sendMock,
        receiving: {
          get: receivingGetMock,
          attachments: { get: attachmentsGetMock },
        },
      },
      webhooks: { verify: webhooksVerifyMock },
    })),
  };
});

import { createResendClient } from '../../src/mail/resendClient';

describe('resendClient', () => {
  beforeEach(() => {
    sendMock.mockReset();
    receivingGetMock.mockReset();
    attachmentsGetMock.mockReset();
    webhooksVerifyMock.mockReset();
  });

  it('sendEmail maps params and returns the new id', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email-123' }, error: null });
    const client = createResendClient('re_test');

    const result = await client.sendEmail({
      from: 'tako@octo.jp',
      to: 'friend@example.com',
      subject: 'Hi',
      text: 'Hello',
      headers: { 'In-Reply-To': '<a@x>' },
      attachments: [{ filename: 'a.txt', content: Buffer.from('x') }],
    });

    expect(result.id).toBe('email-123');
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      from: 'tako@octo.jp',
      to: 'friend@example.com',
      subject: 'Hi',
      text: 'Hello',
      headers: { 'In-Reply-To': '<a@x>' },
    }));
  });

  it('sendEmail throws when Resend returns an error', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'bad request' } });
    const client = createResendClient('re_test');

    await expect(client.sendEmail({ from: 'a@x', to: 'b@x', subject: 's', text: 't' })).rejects.toThrow('bad request');
  });

  // NOTE: resend@6.24.0 (the installed version) shapes GetReceivingEmailResponseSuccess with
  // `id` (not `email_id`) and nullable `text`/`html`/`headers`. See task-5-report.md for details
  // on why the mock below differs from the brief's originally assumed shape.
  it('getReceivedEmail maps the Resend response shape', async () => {
    receivingGetMock.mockResolvedValue({
      data: {
        id: 'email-1',
        from: 'Friend <friend@example.com>',
        to: ['tako@octo.jp'],
        received_for: ['alias@octo.jp'],
        message_id: '<m1@x>',
        subject: 'Hi',
        text: 'body',
        html: '<p>body</p>',
        headers: { 'Message-Id': '<m1@x>' },
        attachments: [
          { id: 'att-1', filename: 'a.pdf', content_type: 'application/pdf', size: 10, content_id: null, content_disposition: null },
        ],
      },
      error: null,
    });
    const client = createResendClient('re_test');

    const email = await client.getReceivedEmail('email-1');
    expect(email.emailId).toBe('email-1');
    expect(email.receivedFor).toEqual(['alias@octo.jp']);
    expect(email.messageId).toBe('<m1@x>');
    expect(email.attachments[0]).toEqual({ id: 'att-1', filename: 'a.pdf', contentType: 'application/pdf', size: 10 });
  });

  it('getReceivedEmail falls back to empty strings/objects for nullable fields', async () => {
    receivingGetMock.mockResolvedValue({
      data: {
        id: 'email-2',
        from: 'friend@example.com',
        to: ['tako@octo.jp'],
        subject: 'No body',
        text: null,
        html: null,
        headers: null,
        attachments: [],
      },
      error: null,
    });
    const client = createResendClient('re_test');

    const email = await client.getReceivedEmail('email-2');
    expect(email.text).toBe('');
    expect(email.html).toBe('');
    expect(email.headers).toEqual({});
    expect(email.receivedFor).toEqual([]);
    expect(email.messageId).toBe('');
  });

  // NOTE: resend@6.24.0's GetAttachmentOptions is `{ emailId, id }`, not `{ emailId, attachmentId }`.
  it('getAttachmentDownloadUrl returns the download_url', async () => {
    attachmentsGetMock.mockResolvedValue({ data: { download_url: 'https://x/y', expires_at: 'later' }, error: null });
    const client = createResendClient('re_test');

    const url = await client.getAttachmentDownloadUrl('email-1', 'att-1');
    expect(url).toBe('https://x/y');
    expect(attachmentsGetMock).toHaveBeenCalledWith({ emailId: 'email-1', id: 'att-1' });
  });

  it('verifyWebhookSignature returns the parsed event on success', async () => {
    webhooksVerifyMock.mockResolvedValue({ type: 'email.received', data: { email_id: 'email-1', from: 'a@x', to: ['b@x'], subject: 's' } });
    const client = createResendClient('re_test');

    const event = await client.verifyWebhookSignature('{}', { id: 'id', timestamp: 'ts', signature: 'sig' }, 'whsec_x');
    expect(event?.type).toBe('email.received');
  });

  it('verifyWebhookSignature returns null when verification throws', async () => {
    webhooksVerifyMock.mockRejectedValue(new Error('bad signature'));
    const client = createResendClient('re_test');

    const event = await client.verifyWebhookSignature('{}', { id: 'id', timestamp: 'ts', signature: 'sig' }, 'whsec_x');
    expect(event).toBeNull();
  });
});
