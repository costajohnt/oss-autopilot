/**
 * Local-state contention tests: concurrent CLI + dashboard writers on one
 * state.json (#1378).
 *
 * The Gist path has a real contention suite (gist-state-store.concurrency.test.ts)
 * pinning the 412/ETag retry bound; this file is its local-mode counterpart.
 * It pins the INTENDED semantics of the current design — optimistic mtime
 * compare-and-swap, NOT serialization:
 *
 * - `saveState()` (state-persistence.ts) holds the advisory `wx`-flag lockfile
 *   only for the duration of the physical write. The CAS check (expected vs.
 *   on-disk `mtimeMs`) runs inside that lock, but no lock is held across a
 *   caller's load → mutate → save window.
 * - `StateManager.save()` passes `lastLoadedMtimeMs` as the CAS baseline and
 *   propagates `ConcurrencyError` on mismatch (unless the caller opts into
 *   `allowReloadAndLoseMutation`).
 * - The documented recovery pattern is reload-reapply: catch
 *   `ConcurrencyError`, call `reloadIfChanged()`, re-apply the mutation, save.
 * - The dashboard server's action handlers do reloadIfChanged() → mutate →
 *   save() with no lock across the window — an external CLI write landing
 *   inside it must surface as ConcurrencyError, not silent loss.
 *
 * Interleavings are controlled by explicit call ordering on two in-process
 * StateManager instances (the race is read-modify-write interleaving, not
 * true parallelism). No sleeps: the seed file's mtime is pinned to a
 * whole-second value in the past via utimesSync, so any real save produces
 * a detectably different mtime deterministically.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from './state.js';
import { ConcurrencyError } from './errors.js';

// ─── File-System Persistence Mock Setup ──────────────────────────────────────
// Same pattern as state-migration.test.ts: redirect all paths.js getters into
// a per-test temp directory so the suite never touches ~/.oss-autopilot/.
// ─────────────────────────────────────────────────────────────────────────────

let mockTmpDir = '';

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  return {
    ...actual,
    getDataDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) {
        fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      }
      return mockTmpDir;
    },
    getStatePath: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) {
        fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      }
      return path.join(mockTmpDir, 'state.json');
    },
    getBackupDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      const backupDir = path.join(mockTmpDir, 'backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      }
      return backupDir;
    },
    getLegacyStatePath: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      return path.join(mockTmpDir, 'legacy-data', 'state.json');
    },
    getLegacyBackupDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      return path.join(mockTmpDir, 'legacy-data', 'backups');
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const URL_A = 'https://github.com/owner/repo/pull/1';
const URL_B = 'https://github.com/owner/repo/pull/2';
const ISSUE_URL = 'https://github.com/owner/repo/issues/3';

function statePath(): string {
  return path.join(mockTmpDir, 'state.json');
}

/**
 * Seed a valid v4 state file on disk and pin its mtime to a whole-second
 * value 10s in the past. Whole seconds round-trip exactly through
 * utimesSync → statSync().mtimeMs on every filesystem, so managers
 * constructed afterwards get a deterministic CAS baseline that can never
 * collide with the mtime of a subsequent real save. Returns the pinned
 * mtime in milliseconds.
 */
function seedStateFile(): number {
  const seeder = new StateManager(false);
  seeder.save(); // first write: lastLoadedMtimeMs is 0, so CAS is bypassed
  const pastSeconds = Math.floor(Date.now() / 1000) - 10;
  fs.utimesSync(statePath(), pastSeconds, pastSeconds);
  return pastSeconds * 1000;
}

function readDiskState(): { config: { shelvedPRUrls?: string[]; dismissedIssues?: Record<string, string> } } {
  return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
}

describe('local state contention: CLI + dashboard on one state.json (#1378)', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-contention-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  // (a) Last writer does NOT win: the stale writer's save is rejected and
  //     the file keeps the first writer's mutation — no merge, no clobber.
  it('rejects the second of two stale-baseline writers with ConcurrencyError, keeping the first write', () => {
    seedStateFile();

    // Both instances load the same baseline mtime (the read-modify-write
    // window opens for both).
    const writerA = new StateManager(false);
    const writerB = new StateManager(false);

    // A mutates and saves first — its CAS baseline still matches disk.
    expect(writerA.shelvePR(URL_A)).toBe(true);

    // B's baseline is now stale; its autoSave inside shelvePR must throw.
    expect(() => writerB.shelvePR(URL_B)).toThrow(ConcurrencyError);

    // Disk contains exactly A's mutation — not B's, not a merge.
    const disk = readDiskState();
    expect(disk.config.shelvedPRUrls).toEqual([URL_A]);
  });

  // (b) Recovery path: reload-reapply after ConcurrencyError lands both
  //     mutations.
  it('reload-reapply after ConcurrencyError persists both writers’ mutations', () => {
    seedStateFile();

    const writerA = new StateManager(false);
    const writerB = new StateManager(false);

    writerA.shelvePR(URL_A);
    expect(() => writerB.shelvePR(URL_B)).toThrow(ConcurrencyError);

    // Recovery: reload picks up A's write (and discards B's unsaved
    // in-memory mutation along with it)...
    expect(writerB.reloadIfChanged()).toBe(true);
    expect(writerB.isPRShelved(URL_A)).toBe(true);
    expect(writerB.isPRShelved(URL_B)).toBe(false);

    // ...then B re-applies its mutation on the fresh baseline and the save
    // goes through.
    expect(writerB.shelvePR(URL_B)).toBe(true);

    const disk = readDiskState();
    expect(disk.config.shelvedPRUrls).toEqual([URL_A, URL_B]);
  });

  // (c) The dashboard action-handler pattern (dashboard-server.ts
  //     handleAction): reloadIfChanged() → mutate → save(), with an external
  //     CLI write landing inside the window. The conflict must surface as
  //     ConcurrencyError (handleAction retries once via reload-reapply, then
  //     returns a retryable 409 to the SPA, #1397) — never silent loss of
  //     the CLI's write.
  it('surfaces ConcurrencyError when an external write lands between the dashboard’s reload and save', () => {
    seedStateFile();

    const dashboard = new StateManager(false);

    // Handler begins: reload finds nothing new (baseline unchanged).
    expect(dashboard.reloadIfChanged()).toBe(false);

    // External CLI process writes between the dashboard's reload and save.
    const cli = new StateManager(false);
    expect(cli.shelvePR(URL_A)).toBe(true);

    // Handler mutates + saves on its now-stale baseline → must throw, and
    // the CLI's write must survive on disk.
    expect(() => dashboard.dismissIssue(ISSUE_URL, new Date().toISOString())).toThrow(ConcurrencyError);

    const disk = readDiskState();
    expect(disk.config.shelvedPRUrls).toEqual([URL_A]);
    expect(disk.config.dismissedIssues?.[ISSUE_URL]).toBeUndefined();
  });

  // (d) mtime-granularity blind spot. The CAS compares statSync().mtimeMs
  //     values for exact equality, so it can only detect an external write
  //     whose mtime differs from the baseline. Node reports mtimeMs with the
  //     filesystem's native precision (sub-millisecond fractional values on
  //     APFS and ext4 — a 200-iteration back-to-back-write probe on APFS
  //     produced 0 collisions — but whole seconds on HFS+/FAT). If two
  //     writes land within the same mtime quantum, the CAS admits a silent
  //     lost update. This test demonstrates that blind spot deterministically
  //     by forcing the external write's mtime back to the baseline value,
  //     standing in for a same-quantum collision; a probabilistic same-ms
  //     race would be flaky, so the limitation is pinned this way instead.
  it('documents the CAS blind spot: an external write with an identical mtime is silently overwritten', () => {
    const pinnedMtimeMs = seedStateFile();

    // Writer loads the pinned baseline.
    const writer = new StateManager(false);

    // External process writes, but its mtime collapses to the same quantum
    // as the baseline (simulated exactly via utimesSync).
    const external = readDiskState();
    external.config.shelvedPRUrls = [URL_B];
    fs.writeFileSync(statePath(), JSON.stringify(external, null, 2), { mode: 0o600 });
    fs.utimesSync(statePath(), pinnedMtimeMs / 1000, pinnedMtimeMs / 1000);

    // The CAS cannot tell the file changed: expected === actual mtimeMs.
    // The save succeeds and the external write is silently lost.
    //
    // NOTE: these assertions pin the LIMITATION of the current mtime-equality
    // CAS, not a desirable contract. If a future implementation adds a second
    // discriminator (content hash, version counter) that detects same-mtime
    // collisions, this save SHOULD start throwing ConcurrencyError — invert
    // these assertions in that change; the blind spot being closed is an
    // improvement, not a regression.
    expect(() => writer.shelvePR(URL_A)).not.toThrow();

    const disk = readDiskState();
    expect(disk.config.shelvedPRUrls).toEqual([URL_A]); // URL_B is gone
  });
});
