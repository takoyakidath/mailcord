import { describe, it, expect } from 'vitest';
import { appendToReferencesChain, buildReplyHeaders, buildReplySubject } from '../../src/mail/headers';

describe('appendToReferencesChain', () => {
  it('starts a new chain when there is none', () => {
    expect(appendToReferencesChain(null, '<msg1@x>')).toBe('<msg1@x>');
  });

  it('appends to an existing chain', () => {
    expect(appendToReferencesChain('<msg1@x>', '<msg2@x>')).toBe('<msg1@x> <msg2@x>');
  });
});

describe('buildReplyHeaders', () => {
  it('sets In-Reply-To and extends References', () => {
    const result = buildReplyHeaders('<msg1@x>', '<msg0@x>');
    expect(result.inReplyTo).toBe('<msg1@x>');
    expect(result.references).toBe('<msg0@x> <msg1@x>');
  });
});

describe('buildReplySubject', () => {
  it('prefixes with Re: when not already present', () => {
    expect(buildReplySubject('Hello')).toBe('Re: Hello');
  });

  it('does not double-prefix', () => {
    expect(buildReplySubject('Re: Hello')).toBe('Re: Hello');
    expect(buildReplySubject('re: Hello')).toBe('re: Hello');
    expect(buildReplySubject('RE: Hello')).toBe('RE: Hello');
  });
});
