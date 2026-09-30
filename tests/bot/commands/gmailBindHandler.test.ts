import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, type Db } from '../../../src/db/client';
import { oauthStates } from '../../../src/db/schema';
import { createBinding } from '../../../src/services/bindingService';
import { handleBindGmailCommand } from '../../../src/bot/commands/gmailBindHandler';
import type { GmailProvider } from '../../../src/services/outboundEmailService';

function fakeGmailProvider(authUrl = 'https://accounts.google.com/o/oauth2/auth?state=abc'): GmailProvider {
  return {
    client: { buildAuthUrl: vi.fn().mockReturnValue(authUrl) } as unknown as GmailProvider['client'],
    tokenEncryptionKey: 'unused-in-this-handler',
  };
}

describe('handleBindGmailCommand', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('reports that Gmail is not configured when gmail is null', async () => {
    const result = await handleBindGmailCommand(db, null, { discordGuildId: 'g1', discordChannelId: 'c1', requestedBy: 'u1' });
    expect(result.replyText).toContain('設定されていません');
  });

  it('rejects a channel that already has a binding', async () => {
    await createBinding(db, { emailAddress: 'tako@octo.jp', discordGuildId: 'g1', discordChannelId: 'c1', createdBy: 'u1' });

    const result = await handleBindGmailCommand(db, fakeGmailProvider(), { discordGuildId: 'g1', discordChannelId: 'c1', requestedBy: 'u1' });

    expect(result.replyText).toContain('既に');
    expect(result.replyText).toContain('unbind');
  });

  it('creates a one-time state row and replies with the Google authorization URL', async () => {
    const gmail = fakeGmailProvider('https://accounts.google.com/o/oauth2/auth?scope=gmail');
    const result = await handleBindGmailCommand(db, gmail, { discordGuildId: 'g1', discordChannelId: 'c1', requestedBy: 'u1' });

    expect(result.replyText).toContain('https://accounts.google.com/o/oauth2/auth?scope=gmail');
    expect(gmail.client.buildAuthUrl).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(oauthStates);
    expect(rows).toHaveLength(1);
    expect(rows[0].discordChannelId).toBe('c1');
    expect(rows[0].requestedBy).toBe('u1');
  });
});
