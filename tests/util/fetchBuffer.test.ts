import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAsBuffer } from '../../src/util/fetchBuffer';

describe('fetchAsBuffer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a Buffer of the response body', async () => {
    const bytes = new TextEncoder().encode('hello');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    }));

    const buf = await fetchAsBuffer('https://example.com/file.txt');
    expect(buf.toString('utf8')).toBe('hello');
  });

  it('throws when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchAsBuffer('https://example.com/missing')).rejects.toThrow();
  });
});
