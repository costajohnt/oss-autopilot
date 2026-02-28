/**
 * Runs a worker pool that processes items with bounded concurrency.
 * N workers consume from a shared index — simpler than Promise.race + splice.
 */
export async function runWorkerPool<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let index = 0;
  const poolWorker = async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => poolWorker()));
}
