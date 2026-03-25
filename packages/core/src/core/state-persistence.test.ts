/**
 * Tests for StateManager file-system persistence, locking, and reload
 * (extracted from state.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateManager, acquireLock, releaseLock, atomicWriteFileSync, resetStateManager } from './state.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── File-System Persistence Mock Setup ──────────────────────────────────────
//
// Module-level variable shared between the vi.mock factory and test helpers.
// Each describe block resets this in beforeEach / afterEach. The mock redirects
// getStatePath / getBackupDir / getDataDir away from ~/.oss-autopilot/ so every
// file-system persistence test operates in a throwaway temp directory.
// ─────────────────────────────────────────────────────────────────────────────

let mockTmpDir = '';

vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
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
  };
});

// Shared config shape used by both makeV2State and makeV1State.
function makeBaseConfig(): Record<string, unknown> {
  return {
    setupComplete: false,
    maxActivePRs: 10,
    dormantThresholdDays: 30,
    approachingDormantDays: 25,
    maxIssueAgeDays: 90,
    languages: ['typescript'],
    labels: ['good first issue'],
    excludeRepos: [],
    trustedProjects: [],
    githubUsername: '',
    minRepoScoreThreshold: 4,
    starredRepos: [],
    squashByDefault: true,
    minStars: 50,
    includeDocIssues: true,
    aiPolicyBlocklist: [],
    shelvedPRUrls: [],
    dismissedIssues: {},
  };
}

// Helper: build a minimal valid v2 state object for writing to disk in tests.
function makeV2State(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    activePRs: [],
    activeIssues: [],
    dormantPRs: [],
    mergedPRs: [],
    closedPRs: [],
    repoScores: {},
    config: makeBaseConfig(),
    events: [],
    lastRunAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Concurrent State Write Protection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-lock-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('atomicWriteFileSync', () => {
    it('should write file content correctly', () => {
      const filePath = path.join(tmpDir, 'test.json');
      const data = JSON.stringify({ hello: 'world' }, null, 2);

      atomicWriteFileSync(filePath, data);

      expect(fs.readFileSync(filePath, 'utf-8')).toBe(data);
    });

    it('should not leave a .tmp file after successful write', () => {
      const filePath = path.join(tmpDir, 'test.json');
      const tmpPath = filePath + '.tmp';

      atomicWriteFileSync(filePath, '{"ok":true}');

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it('should overwrite existing file atomically', () => {
      const filePath = path.join(tmpDir, 'test.json');
      fs.writeFileSync(filePath, '{"version":1}');

      atomicWriteFileSync(filePath, '{"version":2}');

      expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"version":2}');
    });

    it('should apply the specified file mode', () => {
      const filePath = path.join(tmpDir, 'test.json');

      atomicWriteFileSync(filePath, '{}', 0o600);

      const stats = fs.statSync(filePath);
      // Check owner read/write bits (mask out non-owner bits)
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe('acquireLock / releaseLock', () => {
    it('should create a lock file on acquire and remove it on release', () => {
      const lockPath = path.join(tmpDir, 'state.json.lock');

      acquireLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);

      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      expect(lockData.pid).toBe(process.pid);
      expect(typeof lockData.timestamp).toBe('number');

      releaseLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should throw when lock is held by another process', () => {
      const lockPath = path.join(tmpDir, 'state.json.lock');
      // Simulate a lock from another process that is NOT stale
      const lockData = JSON.stringify({ pid: 999999, timestamp: Date.now() });
      fs.writeFileSync(lockPath, lockData, { flag: 'wx' });

      expect(() => acquireLock(lockPath)).toThrow('State file is locked by another process');

      // Clean up (use unlinkSync directly since releaseLock checks PID ownership)
      fs.unlinkSync(lockPath);
    });

    it('should recover from stale locks', () => {
      const lockPath = path.join(tmpDir, 'state.json.lock');
      // Simulate a stale lock (timestamp 60 seconds ago, well past the 30s timeout)
      const staleLockData = JSON.stringify({ pid: 999999, timestamp: Date.now() - 60_000 });
      fs.writeFileSync(lockPath, staleLockData, { flag: 'wx' });

      // Should succeed because the lock is stale
      acquireLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);

      const newLockData = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      expect(newLockData.pid).toBe(process.pid);

      releaseLock(lockPath);
    });

    it('should recover from corrupt lock files', () => {
      const lockPath = path.join(tmpDir, 'state.json.lock');
      // Write invalid JSON to simulate a corrupt lock file
      fs.writeFileSync(lockPath, 'NOT VALID JSON', { flag: 'wx' });

      // Should succeed because corrupt locks are treated as stale
      acquireLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);

      const newLockData = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      expect(newLockData.pid).toBe(process.pid);

      releaseLock(lockPath);
    });

    it('should not release a lock owned by another process', () => {
      const lockPath = path.join(tmpDir, 'state.json.lock');
      // Simulate a lock from another process
      const lockData = JSON.stringify({ pid: 999999, timestamp: Date.now() });
      fs.writeFileSync(lockPath, lockData, { flag: 'wx' });

      // releaseLock should not remove it because PID doesn't match
      releaseLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);

      // Clean up
      fs.unlinkSync(lockPath);
    });

    it('should silently handle releasing a non-existent lock', () => {
      const lockPath = path.join(tmpDir, 'non-existent.lock');
      // Should not throw
      expect(() => releaseLock(lockPath)).not.toThrow();
    });
  });
});

describe('StateManager file-system persistence (save / load)', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-persist-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should write state.json to disk when save() is called', () => {
    const sm = new StateManager(false);
    sm.updateConfig({ githubUsername: 'alice' });
    sm.save();

    const statePath = path.join(mockTmpDir, 'state.json');
    expect(fs.existsSync(statePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.config.githubUsername).toBe('alice');
  });

  it('should set file permissions to 0o600 when writing state', () => {
    const sm = new StateManager(false);
    sm.save();

    const statePath = path.join(mockTmpDir, 'state.json');
    const stats = fs.statSync(statePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('should update lastRunAt on every save()', () => {
    const sm = new StateManager(false);
    const before = new Date().toISOString();
    sm.save();
    const after = new Date().toISOString();

    const statePath = path.join(mockTmpDir, 'state.json');
    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.lastRunAt >= before).toBe(true);
    expect(written.lastRunAt <= after).toBe(true);
  });

  it('should load previously saved state from disk', () => {
    // First instance: save some state
    const sm1 = new StateManager(false);
    sm1.updateConfig({ githubUsername: 'bob' });
    sm1.updateRepoScore('owner/repo', { mergedPRCount: 3 });
    sm1.save();

    // Second instance reading the same file
    const sm2 = new StateManager(false);
    const state = sm2.getState();
    expect(state.config.githubUsername).toBe('bob');
    expect(state.repoScores['owner/repo']).toBeDefined();
    expect(state.repoScores['owner/repo'].mergedPRCount).toBe(3);
  });

  it('should create a backup of the existing state before saving a new one', () => {
    const sm = new StateManager(false);
    sm.save(); // First save: no prior state → no backup yet

    sm.updateConfig({ githubUsername: 'carol' });
    sm.save(); // Second save: existing state.json → creates a backup

    const backupDir = path.join(mockTmpDir, 'backups');
    const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith('state-') && f.endsWith('.json'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('should set backup file permissions to 0o600', () => {
    const sm = new StateManager(false);
    sm.save(); // Create the initial state.json

    sm.updateConfig({ githubUsername: 'dave' });
    sm.save(); // Triggers backup of first save

    const backupDir = path.join(mockTmpDir, 'backups');
    const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith('state-') && f.endsWith('.json'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    for (const backup of backups) {
      const stats = fs.statSync(path.join(backupDir, backup));
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it('should return fresh state when no state file exists', () => {
    // No state.json pre-created — should initialize from scratch
    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.version).toBe(2);

    expect(typeof state.config).toBe('object');
  });

  it('should not leave a .tmp file on disk after save()', () => {
    const sm = new StateManager(false);
    sm.save();

    const tmpFile = path.join(mockTmpDir, 'state.json.tmp');
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('should prune old backups keeping only the 10 most recent', () => {
    // Pre-populate 12 fake backup files with distinct timestamps
    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 0; i < 12; i++) {
      const name = `state-2024-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z-aabbcc.json`;
      fs.writeFileSync(path.join(backupDir, name), JSON.stringify(makeV2State()));
    }

    // Write state.json so save() has something to back up, then save to trigger cleanup
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(makeV2State()), { mode: 0o600 });

    const sm = new StateManager(false);
    sm.save(); // Backs up the existing state.json (13 total) and then prunes to 10

    const remaining = fs.readdirSync(backupDir).filter((f) => f.startsWith('state-'));
    // 12 pre-existing + 1 new backup from save() = 13 total, pruned to exactly 10
    expect(remaining.length).toBe(10);
  });
});

describe('StateManager recovery from corrupt state files', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-corrupt-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should start fresh when state.json contains invalid JSON', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, '{ this is not valid json }', { mode: 0o600 });

    // No backup exists → falls back to fresh state
    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.version).toBe(2);
  });

  it('should restore from backup when state.json is corrupt but a valid backup exists', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    // Create a valid backup with a custom username
    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const fullBackup = makeV2State();
    (fullBackup.config as Record<string, unknown>)['githubUsername'] = 'restored-user';
    fs.writeFileSync(path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-abc123.json'), JSON.stringify(fullBackup), {
      mode: 0o600,
    });

    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.config.githubUsername).toBe('restored-user');
  });

  it('should overwrite corrupt state.json with restored backup contents', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const fullBackup = makeV2State();
    (fullBackup.config as Record<string, unknown>)['githubUsername'] = 'from-backup';
    fs.writeFileSync(path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-abc123.json'), JSON.stringify(fullBackup), {
      mode: 0o600,
    });

    new StateManager(false);

    // state.json should now contain the restored backup data
    const restoredOnDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(restoredOnDisk.config.githubUsername).toBe('from-backup');
  });

  it('should skip corrupt backups and use the next valid one', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    // Newer backup (sorted last = most recent after reverse) is corrupt
    fs.writeFileSync(path.join(backupDir, 'state-2024-02-01T00-00-00-000Z-zzz000.json'), 'ALSO CORRUPT', {
      mode: 0o600,
    });

    // Older backup is valid
    const validBackup = makeV2State();
    (validBackup.config as Record<string, unknown>)['githubUsername'] = 'valid-older-backup';
    fs.writeFileSync(path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-aaa000.json'), JSON.stringify(validBackup), {
      mode: 0o600,
    });

    const sm = new StateManager(false);
    expect(sm.getState().config.githubUsername).toBe('valid-older-backup');
  });

  it('should start fresh when both state.json and all backups are corrupt', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-abc000.json'), 'ALSO CORRUPT', {
      mode: 0o600,
    });

    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.version).toBe(2);
  });

  it('should start fresh when state.json has invalid structure (missing required fields)', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    // Valid JSON but missing required fields (no version, no config)
    fs.writeFileSync(statePath, JSON.stringify({ hello: 'world' }), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.version).toBe(2);
    expect(typeof state.config).toBe('object');
  });
});

describe('StateManager reloadIfChanged', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-reload-'));
  });

  afterEach(() => {
    resetStateManager();
    if (mockTmpDir) {
      fs.rmSync(mockTmpDir, { recursive: true, force: true });
      mockTmpDir = '';
    }
  });

  function makeMinimalState(): Record<string, unknown> {
    return {
      version: 2,
      activeIssues: [],
      repoScores: {},
      config: {
        trustedProjects: [],
        excludeOrgs: [],
        excludeRepos: [],
        shelvedPRUrls: [],
        statusOverrides: {},
        dismissedIssues: {},
        minStars: 50,
      },
      events: [],
      mergedPRs: [],
      closedPRs: [],
    };
  }

  it('should return false when file has not changed', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(makeMinimalState()), { mode: 0o600 });

    const sm = new StateManager(false);
    expect(sm.reloadIfChanged()).toBe(false);
  });

  it('should return true and reload when file was modified externally', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const initial = makeMinimalState();
    fs.writeFileSync(statePath, JSON.stringify(initial), { mode: 0o600 });

    const sm = new StateManager(false);
    expect(sm.getState().config.trustedProjects).toEqual([]);

    // Simulate external CLI write — bump mtime forward to ensure it differs
    const modified = makeMinimalState();
    (modified.config as Record<string, unknown>).trustedProjects = ['ext-org/ext-repo'];
    fs.writeFileSync(statePath, JSON.stringify(modified), { mode: 0o600 });
    const futureTime = new Date(Date.now() + 10_000);
    fs.utimesSync(statePath, futureTime, futureTime);

    expect(sm.reloadIfChanged()).toBe(true);
    expect(sm.getState().config.trustedProjects).toEqual(['ext-org/ext-repo']);
  });

  it('should return false in in-memory mode', () => {
    const sm = new StateManager(true);
    expect(sm.reloadIfChanged()).toBe(false);
  });

  it('should return false after own save() (self-writes do not trigger reload)', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(makeMinimalState()), { mode: 0o600 });

    const sm = new StateManager(false);
    sm.addTrustedProject('my-org/my-repo');
    sm.save();

    expect(sm.reloadIfChanged()).toBe(false);
  });

  it('should return false and not throw when state file is deleted', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(makeMinimalState()), { mode: 0o600 });

    const sm = new StateManager(false);
    fs.unlinkSync(statePath);

    expect(sm.reloadIfChanged()).toBe(false);
  });

  it('should handle corrupted state file during reload without throwing', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(makeMinimalState()), { mode: 0o600 });

    const sm = new StateManager(false);
    fs.writeFileSync(statePath, '{corrupted json!!!', { mode: 0o600 });
    const futureTime = new Date(Date.now() + 10_000);
    fs.utimesSync(statePath, futureTime, futureTime);

    // Should not throw — load() handles corruption internally (backup restore / fresh state)
    expect(() => sm.reloadIfChanged()).not.toThrow();
  });
});

describe('batch and auto-save', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-batch-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should auto-save to disk on a single mutation', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const sm = new StateManager(false);
    sm.updateConfig({ githubUsername: 'alice' });

    // auto-save should have persisted the change
    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.config.githubUsername).toBe('alice');
  });

  it('should defer save until batch completes (single save)', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const sm = new StateManager(false);

    sm.batch(() => {
      sm.updateConfig({ githubUsername: 'bob' });
      sm.updateConfig({ maxActivePRs: 3 });
      sm.updateConfig({ languages: ['rust'] });

      // Mid-batch: file should not yet reflect all changes (or may not exist at all)
      // We test the final result after batch
    });

    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.config.githubUsername).toBe('bob');
    expect(written.config.maxActivePRs).toBe(3);
    expect(written.config.languages).toEqual(['rust']);
  });

  it('should flatten nested batch() calls — only outermost saves', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const sm = new StateManager(false);

    const saveSpy = vi.spyOn(sm, 'save');

    sm.batch(() => {
      sm.updateConfig({ githubUsername: 'carol' });
      sm.batch(() => {
        sm.updateConfig({ maxActivePRs: 7 });
      });
      sm.updateConfig({ languages: ['go'] });
    });

    // save() should be called exactly once (by the outermost batch)
    expect(saveSpy).toHaveBeenCalledTimes(1);

    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.config.githubUsername).toBe('carol');
    expect(written.config.maxActivePRs).toBe(7);
    saveSpy.mockRestore();
  });

  it('should not persist partial state when inner function throws', () => {
    const sm = new StateManager(false);
    const saveSpy = vi.spyOn(sm, 'save');

    expect(() =>
      sm.batch(() => {
        sm.updateConfig({ githubUsername: 'dave' });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // save() is in the try block, so it's skipped on throw — partial state not persisted
    expect(saveSpy).not.toHaveBeenCalled();
    // In-memory state IS mutated (mutations happened before throw)
    expect(sm.getState().config.githubUsername).toBe('dave');
    saveSpy.mockRestore();
  });

  it('should not save when batch has no mutations', () => {
    const sm = new StateManager(false);
    const saveSpy = vi.spyOn(sm, 'save');

    sm.batch(() => {
      // no mutations
    });

    expect(saveSpy).not.toHaveBeenCalled();
    saveSpy.mockRestore();
  });

  it('should not auto-save boolean methods when no actual change (e.g. shelvePR twice)', () => {
    const sm = new StateManager(false);
    const saveSpy = vi.spyOn(sm, 'save');

    const url = 'https://github.com/owner/repo/pull/1';
    sm.shelvePR(url); // first time: actual change → save
    expect(saveSpy).toHaveBeenCalledTimes(1);

    saveSpy.mockClear();
    sm.shelvePR(url); // second time: no change → no save
    expect(saveSpy).not.toHaveBeenCalled();

    saveSpy.mockRestore();
  });

  it('should auto-save on in-memory mode as a no-op (no crash)', () => {
    const sm = new StateManager(true);
    // In-memory save() is a no-op — just ensure no error
    expect(() => sm.updateConfig({ githubUsername: 'test' })).not.toThrow();
    expect(sm.getState().config.githubUsername).toBe('test');
  });
});

// ── State recovery and backup edge cases ────────────────────────────────────
describe('state recovery and backup edge cases', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-recovery-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should restore from backup when state has invalid structure', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    // Valid JSON but structurally invalid (config is null -> fails isValidState)
    fs.writeFileSync(statePath, JSON.stringify({ version: 2, config: null, repoScores: {} }), { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(
      path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-abc123.json'),
      JSON.stringify(makeV2State({ config: { ...makeBaseConfig(), githubUsername: 'backup-user' } })),
      { mode: 0o600 },
    );

    const sm = new StateManager(false);
    expect(sm.getState().config.githubUsername).toBe('backup-user');
  });

  it('should return fresh state when no valid backup files exist', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT JSON', { mode: 0o600 });

    // getBackupDir mock auto-creates the directory, but it will be empty
    const sm = new StateManager(false);
    expect(sm.getState().version).toBe(2);
    expect(sm.getState().config.githubUsername).toBe('');
  });

  it('should handle backup containing non-object JSON', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'state-2024-02-01T00-00-00-000Z-zzz000.json'), 'null', { mode: 0o600 });
    fs.writeFileSync(path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-aaa000.json'), '42', { mode: 0o600 });

    const sm = new StateManager(false);
    expect(sm.getState().version).toBe(2);
    expect(sm.getState().config.githubUsername).toBe('');
  });
});

// ── Save resilience when backup operations fail ─────────────────────────────
describe('save resilience when backup operations fail', () => {
  function createBackupFiles(backupDir: string, count: number): void {
    fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 0; i < count; i++) {
      const name = `state-2024-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z-aabbcc.json`;
      fs.writeFileSync(path.join(backupDir, name), JSON.stringify(makeV2State()));
    }
  }

  function writeInitialState(): string {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(makeV2State()), { mode: 0o600 });
    return statePath;
  }

  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-save-resilience-'));
  });

  afterEach(() => {
    const backupDir = path.join(mockTmpDir, 'backups');
    if (fs.existsSync(backupDir)) {
      fs.chmodSync(backupDir, 0o700);
    }
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should handle unlinkSync failure during backup cleanup', () => {
    const backupDir = path.join(mockTmpDir, 'backups');
    createBackupFiles(backupDir, 12);

    // Replace the oldest backup with a directory so unlinkSync fails (EISDIR)
    const oldestBackup = path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-aabbcc.json');
    fs.unlinkSync(oldestBackup);
    fs.mkdirSync(oldestBackup);

    const statePath = writeInitialState();
    const sm = new StateManager(false);
    expect(() => sm.save()).not.toThrow();

    // The directory-as-file should still exist (unlinkSync failed, error was caught)
    expect(fs.existsSync(oldestBackup)).toBe(true);
    expect(fs.statSync(oldestBackup).isDirectory()).toBe(true);

    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.version).toBe(2);
  });

  it('should handle readdirSync failure during backup cleanup', () => {
    const backupDir = path.join(mockTmpDir, 'backups');
    createBackupFiles(backupDir, 12);

    const statePath = writeInitialState();
    const sm = new StateManager(false);

    // Make backup dir unreadable so both backup copy and cleanup fail
    fs.chmodSync(backupDir, 0o000);

    expect(() => sm.save()).not.toThrow();

    fs.chmodSync(backupDir, 0o700);
    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.version).toBe(2);
  });

  it('should save state even when backup creation fails', () => {
    const statePath = writeInitialState();
    const sm = new StateManager(false);
    sm.updateConfig({ githubUsername: 'updated-user' });

    // Make backup dir read-only so copyFileSync to backup fails
    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.chmodSync(backupDir, 0o555);

    sm.save();

    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.config.githubUsername).toBe('updated-user');
  });
});

// ── reloadStateIfChanged additional edge cases ──────────────────────────────
describe('reloadStateIfChanged additional edge cases', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-reload-edge-'));
  });

  afterEach(() => {
    resetStateManager();
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should return false when state file becomes unreadable', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(makeV2State()), { mode: 0o600 });

    const sm = new StateManager(false);
    fs.chmodSync(statePath, 0o000);

    expect(sm.reloadIfChanged()).toBe(false);

    fs.chmodSync(statePath, 0o600);
  });
});
