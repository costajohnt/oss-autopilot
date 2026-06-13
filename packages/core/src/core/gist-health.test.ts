/**
 * One gist-health source and one warning renderer (#1444).
 *
 * Pins the StateManager.getGistHealth() truth table (local / gist-armed /
 * gist-degraded / configured-but-local) and the renderGistWarning cause →
 * prose mapping every surface (CLI envelope, MCP injection,
 * bootstrapGistBestEffort, daily warnings) now shares.
 */
import { describe, it, expect } from 'vitest';
import { renderGistWarning, type GistWarningCause } from './gist-health.js';
import { StateManager } from './state.js';
import type { GistStateStore } from './gist-state-store.js';

/** In-memory StateManager with test access to the protected gist fields —
 * the truth table needs every (gistStore, gistDegraded, config) combination
 * without running a real Gist bootstrap. */
class TestableStateManager extends StateManager {
  setGist(store: Partial<GistStateStore> | null, degraded: boolean): void {
    this.gistStore = store as GistStateStore | null;
    this.gistDegraded = degraded;
  }
}

function manager(opts: { persistence?: 'local' | 'gist'; gist?: 'armed' | 'degraded' } = {}): TestableStateManager {
  const sm = new TestableStateManager(true);
  if (opts.persistence) sm.updateConfig({ persistence: opts.persistence });
  if (opts.gist) sm.setGist({}, opts.gist === 'degraded');
  return sm;
}

describe('StateManager.getGistHealth() truth table (#1444)', () => {
  it('local manager + local config: healthy local', () => {
    expect(manager({ persistence: 'local' }).getGistHealth()).toEqual({ mode: 'local', degraded: null });
  });

  it('local manager + gist config: configured-but-local, recoverable', () => {
    expect(manager({ persistence: 'gist' }).getGistHealth()).toEqual({
      mode: 'local',
      degraded: { cause: 'configured-but-local', recoverable: true },
    });
  });

  it('gist-armed manager: healthy gist', () => {
    expect(manager({ persistence: 'gist', gist: 'armed' }).getGistHealth()).toEqual({ mode: 'gist', degraded: null });
  });

  it('gist-degraded manager (#1443 disarmed bootstrap): bootstrap-degraded, recoverable', () => {
    expect(manager({ persistence: 'gist', gist: 'degraded' }).getGistHealth()).toEqual({
      mode: 'gist',
      degraded: { cause: 'bootstrap-degraded', recoverable: true },
    });
  });

  it('bootstrap-degraded carries `since` from the staleness marker once one is set', async () => {
    const sm = manager({ persistence: 'gist', gist: 'degraded' });
    // No marker yet → no `since` (the truth-table case above pins this via
    // toEqual). Drive a failed refresh, which sets the staleness marker the
    // same way a degraded bootstrap seeds it.
    sm.setGist(
      {
        refreshFromGist: async () => ({ status: 'error' as const, error: new Error('boom') }),
        lastRefreshError: new Error('boom'),
      },
      true,
    );
    await sm.refreshFromGist();
    const staleness = sm.getStateStaleness();
    expect(staleness).not.toBeNull();
    expect(sm.getGistHealth().degraded?.since).toBe(staleness?.detectedAt);
  });
});

describe('renderGistWarning() cause → prose mapping (#1444)', () => {
  const EXPECTED: Record<GistWarningCause, string> = {
    'no-token': 'no GitHub token was available',
    'state-unreadable': 'the state file could not be read',
    'init-fallback': 'initialization hit a transient network failure',
    'configured-but-local': 'this process is running local-only (Gist init has not succeeded)',
    'bootstrap-degraded': 'the Gist bootstrap fell back to the local cache (reads may be stale and pushes are failing)',
  };

  it.each(Object.entries(EXPECTED))('renders the %s cause in the shared template', (cause, reason) => {
    expect(renderGistWarning(cause as GistWarningCause)).toBe(
      `Gist persistence is configured but ${reason}; writes are LOCAL-ONLY and may be ` +
        'overwritten by the next successful Gist sync.',
    );
  });

  it('accepts a free-form reason for hard init errors', () => {
    expect(renderGistWarning({ reason: 'initialization failed (no gist scope)' })).toBe(
      'Gist persistence is configured but initialization failed (no gist scope); writes are LOCAL-ONLY ' +
        'and may be overwritten by the next successful Gist sync.',
    );
  });

  it('appends the surface-specific retry hint as a trailing sentence', () => {
    expect(renderGistWarning('no-token', { retryHint: 'Will retry on the next tool call.' })).toMatch(
      /Gist sync\. Will retry on the next tool call\.$/,
    );
  });
});
