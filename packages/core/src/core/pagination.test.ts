import { describe, it, expect, vi } from 'vitest';
import { paginateAll, paginateAllDetailed, searchAllPages } from './pagination.js';

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

function item(n: number) {
  return { html_url: `https://github.com/o/r/pull/${n}` };
}

function itemsFrom(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => item(start + i));
}

describe('searchAllPages (#1928)', () => {
  const badGateway = Object.assign(new Error('Bad Gateway'), { status: 502 });

  it('reads one page when it holds every result', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValue({ data: { total_count: 2, incomplete_results: false, items: itemsFrom(1, 2) } });

    const result = await searchAllPages(fetchPage);

    expect(result).toEqual({
      items: itemsFrom(1, 2),
      totalCount: 2,
      pagesRead: 1,
      incomplete: false,
      truncated: false,
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('reads and merges further pages until total_count is reached', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: { total_count: 103, items: itemsFrom(1, 100) } })
      .mockResolvedValueOnce({ data: { total_count: 103, items: itemsFrom(101, 3) } });

    const result = await searchAllPages(fetchPage);

    expect(result.items).toEqual(itemsFrom(1, 103));
    expect(result).toMatchObject({ pagesRead: 2, truncated: false });
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('does not ask for another page when a full page is the whole result', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: { total_count: 100, items: itemsFrom(1, 100) } });

    const result = await searchAllPages(fetchPage);

    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('stops at the page cap and reports the rest as truncated', async () => {
    const fetchPage = vi.fn((page: number) =>
      Promise.resolve({ data: { total_count: 950, items: itemsFrom(page * 100, 100) } }),
    );

    const result = await searchAllPages(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ totalCount: 950, pagesRead: 3, truncated: true });
    expect(result.items).toHaveLength(300);
  });

  it('treats incomplete_results as truncated even when every counted result was read', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValue({ data: { total_count: 1, incomplete_results: true, items: [item(1)] } });

    const result = await searchAllPages(fetchPage);

    expect(result).toMatchObject({ incomplete: true, truncated: true });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('drops an item that an update moved onto the next page as well', async () => {
    // Item 100 was last on page 1; something newer pushed it to the top of page 2.
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: { total_count: 150, items: itemsFrom(1, 100) } })
      .mockResolvedValueOnce({ data: { total_count: 150, items: itemsFrom(100, 51) } });

    const result = await searchAllPages(fetchPage);

    expect(result.items).toEqual(itemsFrom(1, 150));
    expect(result.truncated).toBe(false);
  });

  it('reports truncation when a shift between pages skipped an item, though the raw count looks complete', async () => {
    // 150 rows came back, but one is a repeat: only 149 of the 150 results were seen.
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: { total_count: 150, items: itemsFrom(1, 100) } })
      .mockResolvedValueOnce({ data: { total_count: 150, items: [item(100), ...itemsFrom(102, 49)] } });

    const result = await searchAllPages(fetchPage);

    expect(result.items).toHaveLength(149);
    expect(result.truncated).toBe(true);
  });

  it('keeps the pages read when a later page fails, and hands back the error', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: { total_count: 500, items: itemsFrom(1, 100) } })
      .mockRejectedValueOnce(badGateway);

    const result = await searchAllPages(fetchPage);

    expect(result.items).toEqual(itemsFrom(1, 100));
    expect(result).toMatchObject({ pagesRead: 1, truncated: true, failure: { page: 2, error: badGateway } });
  });

  it('rethrows an error from the first page', async () => {
    const fetchPage = vi.fn().mockRejectedValue(badGateway);

    await expect(searchAllPages(fetchPage)).rejects.toBe(badGateway);
  });

  it('rethrows a rate-limit error from a later page instead of returning a partial list', async () => {
    const rateLimited = Object.assign(new Error('API rate limit exceeded'), { status: 429 });
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: { total_count: 500, items: itemsFrom(1, 100) } })
      .mockRejectedValueOnce(rateLimited);

    await expect(searchAllPages(fetchPage)).rejects.toBe(rateLimited);
  });
});
