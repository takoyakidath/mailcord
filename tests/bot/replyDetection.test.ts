import { describe, it, expect } from 'vitest';
import { classifyIncomingMessage } from '../../src/bot/replyDetection';

describe('classifyIncomingMessage', () => {
  it('ignores messages from bots', () => {
    const result = classifyIncomingMessage({
      channelId: 'c1', messageId: 'm1', authorIsBot: true, content: 'hi', referencedMessageId: null, attachments: [],
    });
    expect(result.kind).toBe('ignore');
  });

  it('ignores plain messages with no reply target', () => {
    const result = classifyIncomingMessage({
      channelId: 'c1', messageId: 'm1', authorIsBot: false, content: 'hi', referencedMessageId: null, attachments: [],
    });
    expect(result.kind).toBe('ignore');
  });

  it('classifies a reply message with its target and body', () => {
    const result = classifyIncomingMessage({
      channelId: 'c1', messageId: 'm1', authorIsBot: false, content: 'Thanks!', referencedMessageId: 'orig-1',
      attachments: [{ filename: 'a.png', url: 'https://x/a.png' }],
    });
    expect(result).toEqual({
      kind: 'reply',
      repliedToDiscordMessageId: 'orig-1',
      body: 'Thanks!',
      attachments: [{ filename: 'a.png', url: 'https://x/a.png' }],
    });
  });
});
