import { describe, it, expect, vi } from 'vitest';
import { Client, TextChannel } from 'discord.js';
import { createDiscordPoster } from '../../src/bot/client';

// EmbedBuilder validates eagerly: a title or author name over 256 characters throws
// synchronously, which would otherwise blackhole the inbound email.
function fakeClientWithChannel() {
  const channel = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
  channel.send = vi.fn().mockResolvedValue({ id: 'discord-msg-1' });
  const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as unknown as Client;
  return { client, channel };
}

describe('createDiscordPoster', () => {
  it('truncates an over-long subject and from so the embed does not throw', async () => {
    const { client, channel } = fakeClientWithChannel();
    const poster = createDiscordPoster(client);

    const result = await poster.postEmailMessage('chan-1', {
      subject: 'S'.repeat(400),
      from: 'F'.repeat(400),
      bodyPreview: 'body',
      attachments: [],
    });

    expect(result).toEqual({ discordMessageId: 'discord-msg-1' });
    const embed = channel.send.mock.calls[0][0].embeds[0].data;
    expect(embed.title).toHaveLength(256);
    expect(embed.title.endsWith('...')).toBe(true);
    expect(embed.author.name).toHaveLength(256);
  });

  it('leaves a short subject and from untouched', async () => {
    const { client, channel } = fakeClientWithChannel();
    const poster = createDiscordPoster(client);

    await poster.postEmailMessage('chan-1', {
      subject: 'Hello',
      from: 'Friend <friend@example.com>',
      bodyPreview: 'body',
      attachments: [],
    });

    const embed = channel.send.mock.calls[0][0].embeds[0].data;
    expect(embed.title).toBe('Hello');
    expect(embed.author.name).toBe('Friend <friend@example.com>');
  });
});
