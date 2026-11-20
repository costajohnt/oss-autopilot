/**
 * Child process for state-lock-processes.test.ts. `cycles` times: take the
 * state lock, read a counter file, pause a millisecond, write counter + 1,
 * release. Without mutual exclusion two processes read the same value and an
 * increment is lost.
 *
 * Usage: node --import tsx lock-contender.ts <lockPath> <counterPath> <cycles>
 */
import * as fs from 'node:fs';
import { acquireLock, releaseLock } from '../core/state-persistence.js';
import { ConcurrencyError } from '../core/errors.js';

const [lockPath, counterPath, cycles] = process.argv.slice(2);

/** The held lock's content, or null when the lock wait timed out (the caller retries). */
function tryAcquire(): string | null {
  try {
    return acquireLock(lockPath);
  } catch (err) {
    if (err instanceof ConcurrencyError) return null;
    throw err;
  }
}

function incrementUnderLock(held: string): void {
  try {
    const value = Number(fs.readFileSync(counterPath, 'utf8'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    fs.writeFileSync(counterPath, String(value + 1));
  } finally {
    releaseLock(lockPath, held);
  }
}

let completed = 0;
while (completed < Number(cycles)) {
  const held = tryAcquire();
  if (held !== null) {
    incrementUnderLock(held);
    completed++;
  }
}
