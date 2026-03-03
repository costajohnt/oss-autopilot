import { describe, it, expect } from 'vitest';
import { runWorkerPool } from './concurrency.js';

describe('runWorkerPool', () => {
  it('processes all items', async () => {
    const items = [1, 2, 3, 4, 5];
    const processed: number[] = [];

    await runWorkerPool(
      items,
      async (item) => {
        processed.push(item);
      },
      3,
    );

    expect(processed.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('respects concurrency limit', async () => {
    let activeConcurrency = 0;
    let maxObservedConcurrency = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];

    await runWorkerPool(
      items,
      async () => {
        activeConcurrency++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeConcurrency);
        // Simulate async work so workers can overlap
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeConcurrency--;
      },
      3,
    );

    expect(maxObservedConcurrency).toBeLessThanOrEqual(3);
    // With 8 items and concurrency 3, we should actually see concurrency > 1
    expect(maxObservedConcurrency).toBeGreaterThan(1);
  });

  it('handles empty array', async () => {
    const processed: number[] = [];

    await runWorkerPool(
      [],
      async (item: number) => {
        processed.push(item);
      },
      5,
    );

    expect(processed).toEqual([]);
  });

  it('propagates worker errors', async () => {
    const items = [1, 2, 3];

    await expect(
      runWorkerPool(
        items,
        async (item) => {
          if (item === 2) throw new Error('item 2 failed');
        },
        1,
      ),
    ).rejects.toThrow('item 2 failed');
  });

  it('aborts remaining items when a worker throws', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const processed: number[] = [];

    await expect(
      runWorkerPool(
        items,
        async (item) => {
          // Simulate async work so multiple workers can pick up items
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (item === 3) throw new Error('item 3 failed');
          processed.push(item);
        },
        2,
      ),
    ).rejects.toThrow('item 3 failed');

    // Not all items should have been processed — the abort flag stops remaining work
    expect(processed.length).toBeLessThan(items.length - 1);
  });

  it('processes items in order with concurrency=1', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const processed: string[] = [];

    await runWorkerPool(
      items,
      async (item) => {
        processed.push(item);
      },
      1,
    );

    expect(processed).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
