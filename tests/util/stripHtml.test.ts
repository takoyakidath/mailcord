import { describe, it, expect } from 'vitest';
import { stripHtml } from '../../src/util/stripHtml';

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello   <b>World</b></p>')).toBe('Hello World');
  });

  it('handles plain text unchanged', () => {
    expect(stripHtml('Hello World')).toBe('Hello World');
  });
});
