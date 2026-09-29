import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from '../../../src/db/client';
import { handleBlockAddCommand, handleBlockRemoveCommand, handleBlockListCommand } from '../../../src/bot/commands/blockHandler';

describe('block command handlers', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('blocks a valid address', async () => {
    const result = await handleBlockAddCommand(db, { emailAddress: 'spammer@example.com', requestedBy: 'user-1' });
    expect(result.replyText).toContain('spammer@example.com');

    const list = await handleBlockListCommand(db);
    expect(list.replyText).toContain('spammer@example.com');
  });

  it('rejects an invalid email address', async () => {
    const result = await handleBlockAddCommand(db, { emailAddress: 'not-an-email', requestedBy: 'user-1' });
    expect(result.replyText).toContain('有効なメールアドレス');

    const list = await handleBlockListCommand(db);
    expect(list.replyText).toContain('いません');
  });

  it('removes a blocked address and reports when there was nothing to remove', async () => {
    const notBlocked = await handleBlockRemoveCommand(db, { emailAddress: 'spammer@example.com' });
    expect(notBlocked.replyText).toContain('ブロックされていません');

    await handleBlockAddCommand(db, { emailAddress: 'spammer@example.com', requestedBy: 'user-1' });
    const removed = await handleBlockRemoveCommand(db, { emailAddress: 'spammer@example.com' });
    expect(removed.replyText).toContain('解除');
  });

  it('list reports when there are no blocked senders', async () => {
    const result = await handleBlockListCommand(db);
    expect(result.replyText).toContain('いません');
  });
});
