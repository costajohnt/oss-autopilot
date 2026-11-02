/**
 * Concurrency primitives shared across modules.
 */

import { isRateLimitOrAuthError } from './errors.js';

/** Default concurrency limit for parallel GitHub API requests. */
export const DEFAULT_CONCURRENCY = 5;

/** Async sleep — exported for mockability in tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a worker pool that processes items with bounded concurrency.
 * N workers consume from a shared index. On any worker error, remaining
 * workers are aborted via a shared flag and the error is propagated.
 */
export async function runWorkerPool<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let index = 0;
  let aborted = false;
  const poolWorker = async () => {
    while (index < items.length) {
      if (aborted) break;
      const item = items[index++];
      try {
        await worker(item);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => poolWorker()));
}

/**
 * Rethrow the first rejection among `settled`, a rate-limit or auth error
 * ahead of any other so a run stops instead of reporting a 404 that the
 * throttled call never got to verify. No-op when nothing rejected.
 */
export function rethrowRejections(settled: readonly PromiseSettledResult<unknown>[]): void {
  const rejections = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejections.length === 0) return;
  const fatal = rejections.find((result) => isRateLimitOrAuthError(result.reason));
  throw (fatal ?? rejections[0]).reason;
}
