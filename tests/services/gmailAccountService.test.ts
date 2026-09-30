import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createDb, type Db } from '../../src/db/client';
import { createBinding } from '../../src/services/bindingService';
import {
  createGmailAccount,
  decryptToken,
  encryptToken,
  getGmailAccountByBindingId,
  getLiveAccessToken,
} from '../../src/services/gmailAccountService';
import type { GmailClient } from '../../src/mail/gmailClient';

const KEY = randomBytes(32).toString('hex');

describe('gmailAccountService', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('round-trips a token through encryptToken/decryptToken', () => {
    const encrypted = encryptToken('super-secret-refresh-token', KEY);
    expect(encrypted).not.toContain('super-secret-refresh-token');
    expect(decryptToken(encrypted, KEY)).toBe('super-secret-refresh-token');
  });

  it('getLiveAccessToken returns the cached token when it still has plenty of life left', async () => {
    const binding = await createBinding(db, { emailAddress: 'tako@gmail.com', discordGuildId: 'g1', discordChannelId: 'c1', createdBy: 'u1', provider: 'gmail' });
    await createGmailAccount(db, KEY, {
      bindingId: binding.id,
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      historyId: '100',
    });
    const account = await getGmailAccountByBindingId(db, binding.id);
    const gmail = { refreshAccessToken: vi.fn() } as unknown as GmailClient;

    const token = await getLiveAccessToken(db, gmail, KEY, account!);

    expect(token).toBe('access-1');
    expect(gmail.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('getLiveAccessToken refreshes and persists a new token when the cached one is near expiry', async () => {
    const binding = await createBinding(db, { emailAddress: 'tako@gmail.com', discordGuildId: 'g1', discordChannelId: 'c1', createdBy: 'u1', provider: 'gmail' });
    await createGmailAccount(db, KEY, {
      bindingId: binding.id,
      refreshToken: 'refresh-1',
      accessToken: 'stale-access',
      accessTokenExpiresAt: new Date(Date.now() + 1000), // under the 60s refresh margin
      historyId: '100',
    });
    const account = await getGmailAccountByBindingId(db, binding.id);
    const gmail = {
      refreshAccessToken: vi.fn().mockResolvedValue({ accessToken: 'fresh-access', expiresAt: new Date(Date.now() + 3600_000) }),
    } as unknown as GmailClient;

    const token = await getLiveAccessToken(db, gmail, KEY, account!);

    expect(token).toBe('fresh-access');
    expect(gmail.refreshAccessToken).toHaveBeenCalledWith('refresh-1');

    const persisted = await getGmailAccountByBindingId(db, binding.id);
    expect(decryptToken(persisted!.encryptedAccessToken!, KEY)).toBe('fresh-access');
  });
});
