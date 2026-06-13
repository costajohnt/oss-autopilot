/**
 * Direct unit tests for GistSyncCoordinator (dashboard-gist-sync.ts).
 *
 * The gist-sync lifecycle used to be reachable only through the dashboard
 * server's full HTTP harness (#1457's stated motivation for the extraction).
 * These tests pin the state machine directly: pending-warning lifecycle
 * (#1417), loss-notice conversion (#1443), and the recovery throttle/halt
 * (#1433). HTTP-level behavior (banners reaching responses, handler
 * ordering) stays covered by dashboard-server.test.ts — not duplicated here.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { ConfigurationError } from '../core/errors.js';

// ── Mock the core barrel ──────────────────────────────────────────────
// Same lazy-dispatch pattern as dashboard-server.test.ts so per-test fakes
// can be swapped without re-mocking the module.
const mockMaybeCheckpoint = vi.fn();
const mockEnsureGistPersistence = vi.fn();
let currentManager: FakeManager;
let currentToken: string | null = null;

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(() => currentManager),
  getGitHubToken: vi.fn(() => currentToken),
  maybeCheckpoint: (...args: unknown[]) => mockMaybeCheckpoint(...args),
  ensureGistPersistence: (...args: unknown[]) => mockEnsureGistPersistence(...args),
}));

import { GistSyncCoordinator } from './dashboard-gist-sync.js';

interface FakeManager {
  getState: ReturnType<typeof vi.fn>;
  isGistMode: ReturnType<typeof vi.fn>;
  isGistDegraded: ReturnType<typeof vi.fn>;
  refreshFromGist: ReturnType<typeof vi.fn>;
  getGistHealth: () => unknown;
}

function makeManager(overrides: Partial<Record<keyof FakeManager, unknown>> = {}): FakeManager {
  const manager: FakeManager = {
    getState: vi.fn(() => ({ config: { persistence: 'local' } })),
    isGistMode: vi.fn(() => false),
    isGistDegraded: vi.fn(() => false),
    refreshFromGist: vi.fn(async () => false),
    // Derived like the real StateManager.getGistHealth (#1444): one
    // isGistMode() consumption per probe, then EITHER getState (local arm)
    // or isGistDegraded (gist arm) — keeps mockReturnValueOnce sequences in
    // the recovery tests consuming the underlying mocks exactly as the old
    // two-probe code did.
    getGistHealth: () => {
      if ((manager.isGistMode as () => boolean)()) {
        return {
          mode: 'gist',
          degraded: (manager.isGistDegraded as () => boolean)()
            ? { cause: 'bootstrap-degraded', recoverable: true }
            : null,
        };
      }
      const state = (manager.getState as () => { config: { persistence: string } })();
      return {
        mode: 'local',
        degraded: state.config.persistence === 'gist' ? { cause: 'configured-but-local', recoverable: true } : null,
      };
    },
    ...(overrides as Partial<FakeManager>),
  };
  return manager;
}

/** Config asks for gist but the manager is local-only — the #1433 degraded window. */
function makeDegradedLocalManager(): FakeManager {
  return makeManager({
    getState: vi.fn(() => ({ config: { persistence: 'gist' } })),
    isGistMode: vi.fn(() => false),
  });
}

function makeCoordinator(token: string | null = null): GistSyncCoordinator {
  currentToken = token;
  return new GistSyncCoordinator(token, 'dashboard-server');
}

describe('GistSyncCoordinator', () => {
  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    currentManager = makeManager();
    currentToken = null;
    mockMaybeCheckpoint.mockReset();
    mockMaybeCheckpoint.mockResolvedValue(null);
    mockEnsureGistPersistence.mockReset();
    mockEnsureGistPersistence.mockResolvedValue('gist');
  });

  describe('pending-warning lifecycle (#1417)', () => {
    it('accumulates warnings without duplicates and clears them all on a successful push', () => {
      const sync = makeCoordinator();

      sync.recordGistSyncOutcome('push failed: a');
      sync.recordGistSyncOutcome('push failed: a');
      sync.recordGistSyncOutcome('push failed: b');
      expect(sync.withPendingGistWarnings(undefined)).toEqual(['push failed: a', 'push failed: b']);

      // null = a successful push carried the FULL current state — all
      // previously pending warnings are resolved with it.
      sync.recordGistSyncOutcome(null);
      expect(sync.withPendingGistWarnings(undefined)).toBeUndefined();
    });

    it('merges into an existing failures payload without duplicating entries already present', () => {
      const sync = makeCoordinator();
      sync.recordGistSyncOutcome('push failed: a');

      const merged = sync.withPendingGistWarnings(['fetch failed', 'push failed: a']);
      expect(merged).toEqual(['fetch failed', 'push failed: a']);
      // And the caller's array is not mutated.
      const base = ['fetch failed'];
      expect(sync.withPendingGistWarnings(base)).toEqual(['fetch failed', 'push failed: a']);
      expect(base).toEqual(['fetch failed']);
    });

    it('flushPendingGistSync is a no-op when nothing is pending and re-pushes when something is', async () => {
      const sync = makeCoordinator();

      await sync.flushPendingGistSync();
      expect(mockMaybeCheckpoint).not.toHaveBeenCalled();

      sync.recordGistSyncOutcome('push failed: a');
      // The retry succeeds (null) — the warning lifecycle ends with the push.
      await sync.flushPendingGistSync();
      expect(mockMaybeCheckpoint).toHaveBeenCalledWith(currentManager, 'dashboard-server');
      expect(sync.withPendingGistWarnings(undefined)).toBeUndefined();
    });
  });

  describe('loss-notice conversion (#1443)', () => {
    it('a pull that replaces state converts still-pending warnings into a loss notice', async () => {
      currentManager = makeManager({ refreshFromGist: vi.fn(async () => true) });
      const sync = makeCoordinator();
      sync.recordGistSyncOutcome('push failed: a');

      await expect(sync.pullFromGist()).resolves.toBe(true);

      const failures = sync.withPendingGistWarnings(undefined)!;
      expect(failures.some((m) => m.includes('NOT synced'))).toBe(true);
      expect(failures).not.toContain('push failed: a');
      // A later unrelated successful push must NOT clear the notice — that
      // push never contained the destroyed mutation.
      sync.recordGistSyncOutcome(null);
      expect(sync.withPendingGistWarnings(undefined)!.some((m) => m.includes('NOT synced'))).toBe(true);
      // The notice retires at the start of the next refresh cycle.
      sync.clearRecoveryLossNotices();
      expect(sync.withPendingGistWarnings(undefined)).toBeUndefined();
    });

    it('a no-change pull leaves pending warnings pending', async () => {
      const sync = makeCoordinator();
      sync.recordGistSyncOutcome('push failed: a');

      await expect(sync.pullFromGist()).resolves.toBe(false);

      expect(sync.withPendingGistWarnings(undefined)).toEqual(['push failed: a']);
    });
  });

  describe('recovery throttle and halt (#1433)', () => {
    it('does not attempt recovery when not degraded', async () => {
      const sync = makeCoordinator('tok');
      await sync.maybeRecoverGist();
      expect(mockEnsureGistPersistence).not.toHaveBeenCalled();
    });

    it('a token-less probe attempts nothing and does not burn the retry window', async () => {
      currentManager = makeDegradedLocalManager();
      const sync = makeCoordinator(null);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await sync.maybeRecoverGist();
        expect(mockEnsureGistPersistence).not.toHaveBeenCalled();

        // Token appears one tick later — still inside what WOULD have been
        // the 30s window had the probe stamped it. The attempt must run.
        currentToken = 'tok';
        nowSpy.mockReturnValue(1_000_001);
        await sync.maybeRecoverGist();
        expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('throttles transient failures to one attempt per interval', async () => {
      currentManager = makeDegradedLocalManager();
      mockEnsureGistPersistence.mockRejectedValue(new Error('network blip'));
      const sync = makeCoordinator('tok');
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await sync.maybeRecoverGist();
        expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);

        // Within the 30s window: no second round trip.
        nowSpy.mockReturnValue(1_000_000 + 29_999);
        await sync.maybeRecoverGist();
        expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);

        // Past the window: one more attempt.
        nowSpy.mockReturnValue(1_000_000 + 30_000);
        await sync.maybeRecoverGist();
        expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('a ConfigurationError halts retries, surfaces the reason in the banner, and unhaltRecovery re-arms', async () => {
      currentManager = makeDegradedLocalManager();
      mockEnsureGistPersistence.mockRejectedValueOnce(new ConfigurationError('token lacks gist scope'));
      const sync = makeCoordinator('tok');
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await sync.maybeRecoverGist();
        expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);

        // Halted: even far past the throttle window, no further round trips.
        nowSpy.mockReturnValue(1_000_000 + 600_000);
        await sync.maybeRecoverGist();
        expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);

        // The root cause reaches the banner instead of the generic warning.
        const failures = sync.withPendingGistWarnings(undefined)!;
        expect(failures.some((m) => m.includes('FAILED permanently') && m.includes('token lacks gist scope'))).toBe(
          true,
        );

        // An external state edit un-halts (#1433 pass-2): one fresh cycle.
        sync.unhaltRecovery();
        nowSpy.mockReturnValue(1_000_000 + 700_000);
        await sync.maybeRecoverGist();
        expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('a successful recovery re-resolves the manager and reports degraded mutations as a loss notice', async () => {
      currentManager = makeDegradedLocalManager();
      const sync = makeCoordinator('tok');

      // Two mutations acknowledged while degraded; a third while healthy
      // (after recovery) must not count.
      sync.recordMutationWhileDegraded();
      sync.recordMutationWhileDegraded();

      // Recovery succeeds: the core singleton is replaced with an armed
      // gist-backed manager.
      const armedManager = makeManager({ isGistMode: vi.fn(() => true) });
      mockEnsureGistPersistence.mockImplementationOnce(async () => {
        currentManager = armedManager;
        return 'gist';
      });
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
      try {
        await sync.maybeRecoverGist();
      } finally {
        nowSpy.mockRestore();
      }

      expect(sync.stateManager).toBe(armedManager);
      const failures = sync.withPendingGistWarnings(undefined)!;
      expect(failures.some((m) => m.includes('2 change(s)') && m.includes('NOT merged'))).toBe(true);

      // Healthy now: further mutations are not counted as degraded, and the
      // count was reset — a hypothetical second recovery has nothing to report.
      sync.recordMutationWhileDegraded();
      sync.clearRecoveryLossNotices();
      expect(sync.withPendingGistWarnings(undefined)).toBeUndefined();
    });
  });

  describe('degraded banners', () => {
    it('adds the LOCAL-ONLY banner while config asks for gist but the manager is local', () => {
      currentManager = makeDegradedLocalManager();
      const sync = makeCoordinator();
      expect(sync.withPendingGistWarnings(undefined)!.some((m) => m.includes('LOCAL-ONLY'))).toBe(true);
      expect(sync.gistConfiguredButLocal()).toBe(true);
    });

    it('adds the stale-bootstrap banner when gist-backed but the bootstrap fell back to the local cache', () => {
      currentManager = makeManager({
        getState: vi.fn(() => ({ config: { persistence: 'gist' } })),
        isGistMode: vi.fn(() => true),
        isGistDegraded: vi.fn(() => true),
      });
      const sync = makeCoordinator();
      expect(sync.withPendingGistWarnings(undefined)!.some((m) => m.includes('fell back to the local cache'))).toBe(
        true,
      );
      expect(sync.gistBootstrapDegraded()).toBe(true);
    });

    it('treats a getState failure in the degraded probe as not degraded (#994 stale-serving path)', () => {
      currentManager = makeManager({
        getState: vi.fn(() => {
          throw new Error('boom');
        }),
      });
      const sync = makeCoordinator();
      expect(sync.gistConfiguredButLocal()).toBe(false);
      expect(sync.withPendingGistWarnings(undefined)).toBeUndefined();
    });
  });
});
