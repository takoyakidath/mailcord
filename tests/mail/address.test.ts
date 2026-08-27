import { describe, it, expect } from 'vitest';
import { extractEmailAddress } from '../../src/mail/address';

describe('extractEmailAddress', () => {
  it('extracts the address from a "Name <addr>" string', () => {
    expect(extractEmailAddress('Acme <noreply@acme.com>')).toBe('noreply@acme.com');
  });

  it('returns a bare address unchanged', () => {
    expect(extractEmailAddress('noreply@acme.com')).toBe('noreply@acme.com');
  });
});
