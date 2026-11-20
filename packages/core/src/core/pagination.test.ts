import { describe, it, expect, vi } from 'vitest';
import { paginateAll, paginateAllDetailed, paginateSearch } from './pagination.js';

describe('paginateAll', () => {
  it('should fetch single page when results < perPage', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ data: [1, 2, 3] });

    const result = await paginateAll(fetchPage, 100);

    expect(result).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(1);
  });

  it('should fetch multiple pages when results = perPage', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => i);
    const page2 = Array.from({ length: 50 }, (_, i) => i + 100);

    const fetchPage = vi.fn().mockResolvedValueOnce({ data: page1 }).mockResolvedValueOnce({ data: page2 });

    const result = await paginateAll(fetchPage, 100);

    expect(result).toEqual([...page1, ...page2]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenCalledWith(1);
    expect(fetchPage).toHaveBeenCalledWith(2);
  });

  it('should stop at maxPages limit', async () => {
    const fullPage = Array.from({ length: 10 }, (_, i) => i);

    const fetchPage = vi.fn().mockResolvedValue({ data: fullPage });

    const result = await paginateAll(fetchPage, 10, 3);

    expect(result).toHaveLength(30);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenCalledWith(1);
    expect(fetchPage).toHaveBeenCalledWith(2);
    expect(fetchPage).toHaveBeenCalledWith(3);
  });

  it('should handle empty first page', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ data: [] });

    const result = await paginateAll(fetchPage, 100);

    expect(result).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('should concatenate all pages correctly', async () => {
    const page1 = [{ id: 1 }, { id: 2 }];
    const page2 = [{ id: 3 }, { id: 4 }];
    const page3 = [{ id: 5 }];

    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 })
      .mockResolvedValueOnce({ data: page3 });

    const result = await paginateAll(fetchPage, 2);

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
});

describe('paginateAllDetailed', () => {
  it('sets truncated when every page up to maxPages is full (#1456)', async () => {
    const fullPage = Array.from({ length: 10 }, (_, i) => i);
    const fetchPage = vi.fn().mockResolvedValue({ data: fullPage });

    const result = await paginateAllDetailed(fetchPage, 10, 3);

    expect(result.items).toHaveLength(30);
    expect(result.truncated).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('does not set truncated when a short page ends pagination naturally', async () => {
    const page1 = Array.from({ length: 10 }, (_, i) => i);
    const page2 = Array.from({ length: 4 }, (_, i) => i + 10);
    const fetchPage = vi.fn().mockResolvedValueOnce({ data: page1 }).mockResolvedValueOnce({ data: page2 });

    const result = await paginateAllDetailed(fetchPage, 10, 3);

    expect(result.items).toHaveLength(14);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('does not set truncated on an empty first page', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ data: [] });

    const result = await paginateAllDetailed(fetchPage, 100);

    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe('paginateSearch (#1928)', () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => i);

  it('reads one page when it holds every result', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: { total_count: 2, incomplete_results: false, items: [1, 2] } });

    const result = await paginateSearch(fetchPage);

    expect(result).toEqual({ items: [1, 2], totalCount: 2, truncated: false });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('reads and merges further pages until total_count is reached', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: { total_count: 103, items: fullPage } })
      .mockResolvedValueOnce({ data: { total_count: 103, items: [100, 101, 102] } });

    const result = await paginateSearch(fetchPage);

    expect(result.items).toHaveLength(103);
    expect(result.items.at(-1)).toBe(102);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('does not ask for another page when a full page is the whole result', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: { total_count: 100, items: fullPage } });

    const result = await paginateSearch(fetchPage);

    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('stops at the page cap and reports the rest as truncated', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: { total_count: 950, items: fullPage } });

    const result = await paginateSearch(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ totalCount: 950, truncated: true });
    expect(result.items).toHaveLength(300);
  });

  it('treats incomplete_results as truncated even when every counted result was read', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: { total_count: 1, incomplete_results: true, items: [1] } });

    const result = await paginateSearch(fetchPage);

    expect(result.truncated).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('propagates a page error unchanged', async () => {
    const error = new Error('API rate limit exceeded');
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: { total_count: 500, items: fullPage } })
      .mockRejectedValueOnce(error);

    await expect(paginateSearch(fetchPage)).rejects.toBe(error);
  });
});
