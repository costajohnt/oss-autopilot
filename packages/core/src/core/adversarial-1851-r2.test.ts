/**
 * Round-2 adversarial regression pins for the Gist conflict recovery.
 * The fake store models the real baseline semantics: a push conflicts for
 * as long as the baseline is stale, and only a refresh makes it fresh.
 */
import { describe, it, expect, vi } from 'vitest';

const warnSpy = vi.fn();
vi.mock('./logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./logger.js')>()),
  warn: (...args: unknown[]) => warnSpy(...args),
}));

import { StateManager, maybeCheckpoint } from './state.js';
import { GistConcurrencyError } from './errors.js';

const X = 'https://github.com/o/r/issues/9';
const T = '2026-10-31T00:00:00.000Z';

function makeManager() {
  const seed = new StateManager(true);
  const remote = structuredClone(seed.getState());
  const pushed: string[] = [];
  let staged = '';
  let isBaselineStale = true; // another machine pushed since our last fetch
  const store = {
    cachedFiles: new Map<string, string>([['state.json', JSON.stringify(remote)]]),
    lastRefreshError: null as Error | null,
    setState(json: string) {
      staged = json;
    },
    async push(): Promise<boolean> {
      if (isBaselineStale) throw new GistConcurrencyError(null, null);
      pushed.push(staged);
      return true;
    },
    async refreshFromGist() {
      isBaselineStale = false;
      store.cachedFiles.set('state.json', JSON.stringify(remote));
      return { status: 'refreshed' as const };
    },
  };
  const manager = new StateManager(true);
  (manager as unknown as { gistStore: unknown }).gistStore = store;
  return { manager, pushed };
}

const dismissedIn = (payload: string): Record<string, string> =>
  (JSON.parse(payload) as { config: { dismissedIssues?: Record<string, string> } }).config.dismissedIssues ?? {};

describe('PR #1851 round 2', () => {
  it('state-sync in the MCP server: the conflict names the command to re-run, and a later reload surfaces the loss', async () => {
    const { manager, pushed } = makeManager();
    manager.dismissIssue(X, T); // earlier tool's push failed: "re-run the command"

    // wrapTool for runStateSync: body -> conflict -> forced reload -> body.
    await expect(manager.runMutation(() => manager.checkpoint())).rejects.toBeInstanceOf(GistConcurrencyError);
    expect(await manager.refreshFromGist({ force: true })).toBe(false); // refused (depth 0, unpushed)
    let second: unknown;
    try {
      await manager.runMutation(() => manager.checkpoint());
    } catch (e) {
      second = e;
    }
    expect(second).toBeInstanceOf(GistConcurrencyError);
    // The error the agent sees must not send it back to state --sync in a
    // loop: state --sync cannot merge; the originating command can.
    expect((second as Error).message).toMatch(/state --sync/);
    expect((second as Error).message).toMatch(/still in memory/);
    expect((second as Error).message).toMatch(/re-run the command that made the change/);

    // >30s later any tool call's non-forced reload runs. X cannot survive it
    // (nothing can re-apply it), so the loss is surfaced where commands and
    // the dashboard already read staleness, instead of a stderr-only line.
    expect(await manager.refreshFromGist()).toBe(true);
    expect(pushed.some((p) => Object.hasOwn(dismissedIn(p), X))).toBe(false);
    expect(manager.getIssueDismissedAt(X)).not.toBe(T);
    expect(manager.getStateStaleness()?.reason).toMatch(/NOT synced.*re-run the command that made the change/i);
  });

  it('a successful conflict recovery must not log "un-pushed changes ... were not synced"', async () => {
    const { manager, pushed } = makeManager();
    warnSpy.mockClear();
    manager.dismissIssue(X, T);
    const warning = await maybeCheckpoint(manager, 'dismiss', () => manager.dismissIssue(X, T));
    expect(warning).toBeNull();
    expect(dismissedIn(pushed.at(-1)!)).toHaveProperty(X); // recovery worked...
    const notSyncedWarns = warnSpy.mock.calls.filter((c) =>
      /un-pushed changes; they were not synced/.test(String(c[1])),
    );
    expect(notSyncedWarns).toHaveLength(0); // ...and stderr does not claim the change was lost
  });
});
