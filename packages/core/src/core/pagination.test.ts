import { describe, it, expect, vi } from 'vitest';
import { paginateAll } from './pagination.js';

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
