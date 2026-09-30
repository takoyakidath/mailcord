import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGmailClient } from '../../src/mail/gmailClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('gmailClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const client = createGmailClient('client-id', 'client-secret', 'https://example.com/oauth/gmail/callback');

  it('buildAuthUrl requests the readonly+send scopes and offline access', () => {
    const url = new URL(client.buildAuthUrl('state-123'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toContain('gmail.readonly');
    expect(url.searchParams.get('scope')).toContain('gmail.send');
    expect(url.searchParams.get('scope')).not.toContain('mail.google.com');
  });

  describe('listHistory', () => {
    it('collects messagesAdded across pages and returns the latest historyId', async () => {
      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(
          jsonResponse({
            history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }],
            nextPageToken: 'page-2',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            history: [{ messagesAdded: [{ message: { id: 'm2', threadId: 't2' } }] }],
            historyId: '999',
          }),
        );

      const result = await client.listHistory('access-token', '100');

      expect(result).toEqual({
        newMessages: [
          { id: 'm1', threadId: 't1' },
          { id: 'm2', threadId: 't2' },
        ],
        newHistoryId: '999',
        historyGone: false,
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const firstUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(firstUrl).toContain('labelId=INBOX');
      expect(firstUrl).toContain('historyTypes=messageAdded');
    });

    it('sets historyGone on a 404 instead of throwing', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404));

      const result = await client.listHistory('access-token', 'too-old');

      expect(result).toEqual({ newMessages: [], newHistoryId: 'too-old', historyGone: true });
    });

    it('propagates a non-404 error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));

      await expect(client.listHistory('access-token', '100')).rejects.toThrow();
    });
  });

  describe('getMessageMetadata', () => {
    it('requests format=metadata with an explicit header allowlist and never format=full/raw', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          id: 'm1',
          threadId: 't1',
          labelIds: ['INBOX', 'UNREAD'],
          payload: {
            headers: [
              { name: 'Subject', value: 'こんにちは' },
              { name: 'From', value: 'Friend <friend@example.com>' },
              { name: 'Message-ID', value: '<abc@mail.gmail.com>' },
            ],
          },
        }),
      );

      const metadata = await client.getMessageMetadata('access-token', 'm1');

      expect(metadata).toEqual({
        id: 'm1',
        threadId: 't1',
        subject: 'こんにちは',
        from: 'Friend <friend@example.com>',
        labelIds: ['INBOX', 'UNREAD'],
        messageIdHeader: '<abc@mail.gmail.com>',
        inReplyTo: null,
        references: null,
      });

      const requestedUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(requestedUrl).toContain('format=metadata');
      expect(requestedUrl).not.toContain('format=full');
      expect(requestedUrl).not.toContain('format=raw');
    });
  });

  describe('sendRawMessage', () => {
    it('base64url-encodes the raw message and forwards threadId', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ id: 'sent-1', threadId: 'thread-1' }));

      const result = await client.sendRawMessage('access-token', Buffer.from('Subject: hi\r\n\r\nbody'), 'thread-1');

      expect(result).toEqual({ id: 'sent-1', threadId: 'thread-1' });
      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.threadId).toBe('thread-1');
      expect(Buffer.from(body.raw, 'base64url').toString('utf8')).toBe('Subject: hi\r\n\r\nbody');
    });
  });
});
