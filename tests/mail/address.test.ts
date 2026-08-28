import { describe, it, expect } from 'vitest';
import { extractEmailAddress, isValidEmailAddress } from '../../src/mail/address';

describe('extractEmailAddress', () => {
  it('extracts the address from a "Name <addr>" string', () => {
    expect(extractEmailAddress('Acme <noreply@acme.com>')).toBe('noreply@acme.com');
  });

  it('returns a bare address unchanged', () => {
    expect(extractEmailAddress('noreply@acme.com')).toBe('noreply@acme.com');
  });

  it('trims whitespace padding inside angle brackets', () => {
    expect(extractEmailAddress('Name < a@b.com >')).toBe('a@b.com');
  });
});

describe('isValidEmailAddress', () => {
  it('accepts a well-formed address', () => {
    expect(isValidEmailAddress('tako@octo.jp')).toBe(true);
  });

  it('rejects strings with no @, no domain, or embedded whitespace', () => {
    expect(isValidEmailAddress('not-an-email')).toBe(false);
    expect(isValidEmailAddress('tako@octo')).toBe(false);
    expect(isValidEmailAddress('tako @octo.jp')).toBe(false);
    expect(isValidEmailAddress('')).toBe(false);
  });
});
