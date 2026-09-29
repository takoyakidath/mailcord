import { describe, it, expect } from 'vitest';
import { classifySpam } from '../../src/services/spamFilter';

describe('classifySpam', () => {
  it('flags a subject/body containing a known spam keyword', () => {
    const result = classifySpam({ subject: '当選しました!', text: '今すぐクリックして受け取ってください' });
    expect(result.isSpam).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('flags an all-caps subject', () => {
    const result = classifySpam({ subject: 'URGENT ACTION REQUIRED', text: 'please respond' });
    expect(result.isSpam).toBe(true);
    expect(result.reasons).toContain('subject is all caps');
  });

  it('flags a subject with excessive exclamation marks', () => {
    const result = classifySpam({ subject: 'Hurry!!!', text: 'body' });
    expect(result.isSpam).toBe(true);
    expect(result.reasons).toContain('excessive exclamation marks in subject');
  });

  it('does not flag an ordinary email', () => {
    const result = classifySpam({ subject: 'Hello', text: 'Just checking in about tomorrow.' });
    expect(result.isSpam).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('is case-insensitive for English keywords', () => {
    const result = classifySpam({ subject: 'You Have Won a prize', text: 'body' });
    expect(result.isSpam).toBe(true);
  });
});
