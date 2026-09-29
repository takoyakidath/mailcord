import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { blockSender, unblockSender, listBlockedSenders, isSenderBlocked } from '../../src/services/blocklistService';

describe('blocklistService', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('blocks a sender and reports it as blocked, case-insensitively', async () => {
    await blockSender(db, { emailAddress: 'Spammer@Example.com', createdBy: 'user-1' });
    expect(await isSenderBlocked(db, 'spammer@example.com')).toBe(true);
  });

  it('reports an unblocked address as not blocked', async () => {
    expect(await isSenderBlocked(db, 'nobody@example.com')).toBe(false);
  });

  it('blocking the same address twice does not create duplicate rows', async () => {
    await blockSender(db, { emailAddress: 'spammer@example.com', createdBy: 'user-1' });
    await blockSender(db, { emailAddress: 'spammer@example.com', createdBy: 'user-2' });
    const all = await listBlockedSenders(db);
    expect(all).toHaveLength(1);
  });

  it('unblocks a sender and reports whether one existed', async () => {
    expect(await unblockSender(db, 'spammer@example.com')).toBe(false);
    await blockSender(db, { emailAddress: 'spammer@example.com', createdBy: 'user-1' });
    expect(await unblockSender(db, 'spammer@example.com')).toBe(true);
    expect(await isSenderBlocked(db, 'spammer@example.com')).toBe(false);
  });

  it('lists all blocked senders', async () => {
    await blockSender(db, { emailAddress: 'a@example.com', createdBy: 'user-1' });
    await blockSender(db, { emailAddress: 'b@example.com', createdBy: 'user-1' });
    const all = await listBlockedSenders(db);
    expect(all.map((b) => b.emailAddress).sort()).toEqual(['a@example.com', 'b@example.com']);
  });
});
