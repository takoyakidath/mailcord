import { describe, it, expect } from 'vitest';
import { stripHtml } from '../../src/util/stripHtml';

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello   <b>World</b></p>')).toBe('Hello World');
  });

  it('handles plain text unchanged', () => {
    expect(stripHtml('Hello World')).toBe('Hello World');
  });

  it('returns an empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });

  it('returns an empty string for whitespace-only or tag-only input', () => {
    expect(stripHtml('   ')).toBe('');
    expect(stripHtml('<div></div>')).toBe('');
  });
});
