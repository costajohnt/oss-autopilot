/**
 * Adversarial regression pins for the Gist conflict-recovery design
 * (audit 2026-10-30 H1/M1/M2). Each test reproduces a hole found in review:
 * a sibling mutation orphaned by a forced refresh, a depth-0 forced reload
 * discarding un-pushed state, and a recovery refresh bypassing the
 * dashboard's loss-notice conversion. No network, no real Gist.
 */
import { describe, it, expect } from 'vitest';
import { StateManager, maybeCheckpoint } from './state.js';
import { GistConcurrencyError } from './errors.js';
import { GistSyncCoordinator } from '../commands/dashboard-gist-sync.js';

const A = 'https://github.com/o/r/issues/1';
const B = 'https://github.com/o/r/issues/2';
const X = 'https://github.com/o/r/issues/9';
const T = '2026-10-31T00:00:00.000Z';

/** Fake GistStateStore: the first push throws GistConcurrencyError, the rest succeed. */
function makeStore(remote: unknown) {
  const pushed: string[] = [];
  let staged = '';
  let conflicts = 1;
  const store = {
    cachedFiles: new Map<string, string>([['state.json', JSON.stringify(remote)]]),
    lastRefreshError: null as Error | null,
    setState(json: string) {
      staged = json;
    },
    async push(): Promise<boolean> {
      if (conflicts > 0) {
        conflicts--;
        throw new GistConcurrencyError(null, null);
      }
      pushed.push(staged);
      return true;
    },
    async refreshFromGist() {
      store.cachedFiles.set('state.json', JSON.stringify(remote));
      return { status: 'refreshed' as const };
    },
  };
  return { store, pushed };
}

function makeManager(remote: unknown) {
  const manager = new StateManager(true);
  const { store, pushed } = makeStore(remote);
  (manager as unknown as { gistStore: unknown }).gistStore = store;
  return { manager, pushed, store };
}

/** A pristine default state, as another machine would have pushed it. */
function freshRemote(): unknown {
  const seed = new StateManager(true);
  return structuredClone(seed.getState());
}

const dismissedIn = (payload: string): Record<string, string> =>
  (JSON.parse(payload) as { config: { dismissedIssues?: Record<string, string> } }).config.dismissedIssues ?? {};

describe('PR #1851 adversarial: forced refresh vs a sibling un-pushed mutation', () => {
  it('two concurrent MCP tool bodies: A recovers from a conflict without dropping B', async () => {
    const { manager, pushed } = makeManager(freshRemote());

    // Two parallel tool calls from one Claude Code message, both inside
    // runMutation (tools.ts runBody). B mutates, then yields (network
    // round-trip in its own body) while A's checkpoint conflicts.
    let releaseB!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const bodyB = manager.runMutation(async () => {
      manager.dismissIssue(B, T);
      await gate;
      return maybeCheckpoint(manager, 'B', () => manager.dismissIssue(B, T));
    });
    const bodyA = manager.runMutation(async () => {
      manager.dismissIssue(A, T);
      return maybeCheckpoint(manager, 'A', () => manager.dismissIssue(A, T));
    });
    const warnA = await bodyA;
    releaseB();
    const warnB = await bodyB;

    expect(warnA).toBeNull();
    // A's recovery swapped the state object while B was mid-body; B's
    // maybeCheckpoint re-applies before its push, so B survives.
    expect(warnB).toBeNull();
    const last = dismissedIn(pushed.at(-1)!);
    expect(last).toHaveProperty(A);
    expect(last).toHaveProperty(B);
    expect(manager.getIssueDismissedAt(B)).toBe(T);
  });

  it('wrapTool conflict retry (M1 path, e.g. state-sync): a forced reload must not discard the un-pushed mutation', async () => {
    const { manager, pushed } = makeManager(freshRemote());

    // An earlier tool's checkpoint failed ("re-run the command"); the
    // dismissal lives only in memory. The user runs `state-sync` to retry.
    manager.dismissIssue(X, T);

    // Exactly what wrapTool does for a tool that throws GistConcurrencyError
    // (runStateSync -> checkpoint): reloadExternalState({force:true}) then
    // re-run the body.
    await expect(manager.runMutation(() => manager.checkpoint())).rejects.toBeInstanceOf(GistConcurrencyError);
    await manager.refreshFromGist({ force: true });
    const pushedOk = await manager.runMutation(() => manager.checkpoint());

    // The depth-0 forced refresh is refused while changes are un-pushed, so
    // the retried push still carries X instead of the remote copy.
    expect(pushedOk).toBe(true);
    expect(dismissedIn(pushed.at(-1)!)).toHaveProperty(X);
  });

  it('dashboard: a recovery refresh that drops a pending un-pushed change produces a loss notice (#1443 invariant)', async () => {
    const { manager, pushed } = makeManager(freshRemote());
    const sync = new GistSyncCoordinator(null, 'test');
    (sync as unknown as { manager: StateManager }).manager = manager;

    // Action 1 dismissed X; its push failed (network) -> pending warning,
    // X only in memory. Remote moved on (another machine pushed).
    manager.dismissIssue(X, T);
    sync.recordGistSyncOutcome('Gist checkpoint push failed after retry; ...');

    // Action 2 (dismiss A) through the same path handleAction uses:
    // runDismiss -> maybeCheckpoint(reapply). Conflict -> force refresh
    // (NOT via pullFromGist) -> reapply A -> push OK -> null.
    manager.dismissIssue(A, T);
    const warning = await sync.stateManager.runMutation(() =>
      maybeCheckpoint(manager, 'dismiss', () => manager.dismissIssue(A, T)),
    );
    sync.recordGistSyncOutcome(warning);

    const banner = sync.withPendingGistWarnings(undefined) ?? [];
    expect(dismissedIn(pushed.at(-1)!)).not.toHaveProperty(X); // X really is gone
    // The push that resolved the pending warning ran after a refresh, so the
    // coordinator converts it to a loss notice instead of clearing it.
    expect(banner.some((w) => /NOT synced|reverted/.test(w))).toBe(true);
  });
});
