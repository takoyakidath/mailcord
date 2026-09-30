import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createDb, type Db } from '../../src/db/client';
import { createBinding } from '../../src/services/bindingService';
import { createGmailAccount, getGmailAccountByBindingId } from '../../src/services/gmailAccountService';
import { blockSender } from '../../src/services/blocklistService';
import { resolveThreadByDiscordMessageId } from '../../src/services/threadService';
import { pollAllGmailBindings } from '../../src/services/gmailPollingService';
import type { GmailClient, GmailMessageMetadata } from '../../src/mail/gmailClient';
import type { DiscordPoster } from '../../src/services/inboundEmailService';

const KEY = randomBytes(32).toString('hex');

function fakeMetadata(overrides: Partial<GmailMessageMetadata> = {}): GmailMessageMetadata {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    subject: 'Hello',
    from: 'friend@example.com',
    labelIds: ['INBOX'],
    messageIdHeader: '<msg-1@mail.gmail.com>',
    inReplyTo: null,
    references: null,
    ...overrides,
  };
}

function fakePoster(): DiscordPoster {
  return {
    postEmailMessage: vi.fn(),
    postGmailMessage: vi.fn().mockResolvedValue({ discordMessageId: 'discord-msg-1' }),
    postSystemMessage: vi.fn(),
  };
}

async function bindGmail(db: Db, channelId: string, historyId = '100') {
  const binding = await createBinding(db, {
    emailAddress: `${channelId}@gmail.com`,
    discordGuildId: 'g1',
    discordChannelId: channelId,
    createdBy: 'u1',
    provider: 'gmail',
  });
  await createGmailAccount(db, KEY, {
    bindingId: binding.id,
    refreshToken: 'refresh',
    accessToken: 'access',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    historyId,
  });
  return binding;
}

describe('gmailPollingService', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('posts a new message and advances the stored historyId', async () => {
    const binding = await bindGmail(db, 'chan-1');
    const poster = fakePoster();
    const gmail = {
      listHistory: vi.fn().mockResolvedValue({ newMessages: [{ id: 'msg-1', threadId: 'thread-1' }], newHistoryId: '200', historyGone: false }),
      getMessageMetadata: vi.fn().mockResolvedValue(fakeMetadata()),
    } as unknown as GmailClient;

    await pollAllGmailBindings(db, gmail, KEY, poster);

    expect(poster.postGmailMessage).toHaveBeenCalledWith('chan-1', {
      subject: 'Hello',
      from: 'friend@example.com',
      viewUrl: 'https://mail.google.com/mail/u/0/#all/msg-1',
    });
    const account = await getGmailAccountByBindingId(db, binding.id);
    expect(account?.historyId).toBe('200');

    const thread = await resolveThreadByDiscordMessageId(db, 'discord-msg-1');
    expect(thread?.gmailThreadId).toBe('thread-1');
    expect(thread?.direction).toBe('inbound');
  });

  it('re-baselines from the profile and posts nothing when history is gone', async () => {
    const binding = await bindGmail(db, 'chan-1', 'stale-cursor');
    const poster = fakePoster();
    const gmail = {
      listHistory: vi.fn().mockResolvedValue({ newMessages: [], newHistoryId: 'stale-cursor', historyGone: true }),
      getProfile: vi.fn().mockResolvedValue({ emailAddress: 'chan-1@gmail.com', historyId: 'fresh-baseline' }),
      getMessageMetadata: vi.fn(),
    } as unknown as GmailClient;

    await pollAllGmailBindings(db, gmail, KEY, poster);

    expect(poster.postGmailMessage).not.toHaveBeenCalled();
    expect(gmail.getProfile).toHaveBeenCalled();
    const account = await getGmailAccountByBindingId(db, binding.id);
    expect(account?.historyId).toBe('fresh-baseline');
  });

  it('skips a message from a blocked sender', async () => {
    await bindGmail(db, 'chan-1');
    await blockSender(db, { emailAddress: 'spammer@example.com', createdBy: 'u1' });
    const poster = fakePoster();
    const gmail = {
      listHistory: vi.fn().mockResolvedValue({ newMessages: [{ id: 'msg-1', threadId: 'thread-1' }], newHistoryId: '200', historyGone: false }),
      getMessageMetadata: vi.fn().mockResolvedValue(fakeMetadata({ from: 'spammer@example.com' })),
    } as unknown as GmailClient;

    await pollAllGmailBindings(db, gmail, KEY, poster);

    expect(poster.postGmailMessage).not.toHaveBeenCalled();
  });

  it('skips a message missing the INBOX label (e.g. our own outbound send)', async () => {
    await bindGmail(db, 'chan-1');
    const poster = fakePoster();
    const gmail = {
      listHistory: vi.fn().mockResolvedValue({ newMessages: [{ id: 'msg-1', threadId: 'thread-1' }], newHistoryId: '200', historyGone: false }),
      getMessageMetadata: vi.fn().mockResolvedValue(fakeMetadata({ labelIds: ['SENT'] })),
    } as unknown as GmailClient;

    await pollAllGmailBindings(db, gmail, KEY, poster);

    expect(poster.postGmailMessage).not.toHaveBeenCalled();
  });

  it('does not reprocess a message already marked processed', async () => {
    await bindGmail(db, 'chan-1');
    const poster = fakePoster();
    const gmail = {
      listHistory: vi.fn().mockResolvedValue({ newMessages: [{ id: 'msg-1', threadId: 'thread-1' }], newHistoryId: '200', historyGone: false }),
      getMessageMetadata: vi.fn().mockResolvedValue(fakeMetadata()),
    } as unknown as GmailClient;

    await pollAllGmailBindings(db, gmail, KEY, poster);
    await pollAllGmailBindings(db, gmail, KEY, poster);

    expect(poster.postGmailMessage).toHaveBeenCalledTimes(1);
  });

  it('isolates one failing binding from another', async () => {
    await bindGmail(db, 'chan-broken');
    await bindGmail(db, 'chan-ok');
    const poster = fakePoster();
    const gmail = {
      listHistory: vi
        .fn()
        .mockRejectedValueOnce(new Error('token revoked'))
        .mockResolvedValueOnce({ newMessages: [{ id: 'msg-1', threadId: 'thread-1' }], newHistoryId: '200', historyGone: false }),
      getMessageMetadata: vi.fn().mockResolvedValue(fakeMetadata()),
    } as unknown as GmailClient;

    await pollAllGmailBindings(db, gmail, KEY, poster);

    expect(poster.postGmailMessage).toHaveBeenCalledTimes(1);
  });
});
