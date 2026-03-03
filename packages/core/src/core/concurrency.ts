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
