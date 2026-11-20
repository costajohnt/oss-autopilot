/**
 * Mutual exclusion of the state lock across real processes (#1951): four
 * children increment one counter file under the lock, and no increment may be
 * lost. Everything lives in a temp dir; no state file is involved.
 *
 * The children increment a plain counter rather than run loadState/saveState
 * cycles: saveState's lost-update guard compares mtimes, and on file systems
 * with coarse timestamps two saves inside one tick look identical, so that
 * loop could lose an update with a perfectly exclusive lock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const PACKAGE_DIR = path.resolve(__dirname, '../..');
const CONTENDER = path.join(PACKAGE_DIR, 'src/test-lib/lock-contender.ts');
const PROCESSES = 4;
const CYCLES = 25;

const scratch = { dir: '' };

beforeEach(() => {
  scratch.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-lock-processes-'));
});

afterEach(() => {
  fs.rmSync(scratch.dir, { recursive: true, force: true });
});

/** Run one contender to completion and resolve with its exit code. */
function runContender(lockPath: string, counterPath: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CONTENDER, lockPath, counterPath, String(CYCLES)], {
      cwd: PACKAGE_DIR,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', resolve);
  });
}

describe('state lock across processes', () => {
  it('loses no increment when four processes contend for the lock', async () => {
    const lockPath = path.join(scratch.dir, 'state.json.lock');
    const counterPath = path.join(scratch.dir, 'counter');
    fs.writeFileSync(counterPath, '0');

    const contenders = Array.from({ length: PROCESSES }, () => runContender(lockPath, counterPath));
    const exitCodes = await Promise.all(contenders);

    expect(exitCodes).toEqual([0, 0, 0, 0]);
    expect(Number(fs.readFileSync(counterPath, 'utf8'))).toBe(PROCESSES * CYCLES);
    expect(fs.readdirSync(scratch.dir)).toEqual(['counter']);
  }, 60_000);
});
