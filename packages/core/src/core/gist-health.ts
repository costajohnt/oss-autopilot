/**
 * One health source and one warning renderer for gist persistence (#1444).
 *
 * "Are we degraded?" used to be answered by three independent predicates
 * (`config.persistence === 'gist' && !isGistMode()`, the
 * `GistPersistenceStatus` union, `isGistMode() && isGistDegraded()`), each
 * re-rendering its own warning prose. `StateManager.getGistHealth()` is now
 * the single predicate for live-manager surfaces (daily warnings, dashboard
 * probes), and {@link renderGistWarning} is the single prose renderer for
 * every surface (CLI envelope, MCP injection, bootstrapGistBestEffort,
 * daily warnings).
 */

/**
 * Degradation causes a live StateManager can attest to from its own fields
 * (see `StateManager.getGistHealth()`):
 *
 * - `configured-but-local`: config says `persistence: 'gist'` but this
 *   process's manager has no gist store — init never ran here, or fell back
 *   to a local-only manager. Mutations save locally and will not sync.
 * - `bootstrap-degraded`: the manager IS gist-backed, but the bootstrap fell
 *   back to the local cache and the store is disarmed (#1443) — reads may be
 *   stale and pushes fail.
 */
export type GistHealthDegradedCause = 'configured-but-local' | 'bootstrap-degraded';

/**
 * Causes {@link renderGistWarning} can name. Superset of
 * {@link GistHealthDegradedCause}: the process-level bootstrap outcomes are
 * observed by config-peek paths (`ensureGistPersistence`, the MCP init memo)
 * that run before or around manager creation, where there is no
 * StateManager to ask:
 *
 * - `no-token`: gist is configured but no GitHub token was available.
 * - `state-unreadable`: the state file could not be read for this attempt.
 * - `init-fallback`: init resolved degraded — `ensureGistPersistence`
 *   reported `'degraded'` (transient network fallback, or a #1443 degraded
 *   bootstrap, which it deliberately conflates at that layer).
 */
export type GistWarningCause = GistHealthDegradedCause | 'no-token' | 'state-unreadable' | 'init-fallback';

/**
 * Snapshot of gist persistence health from the one source of truth
 * (`StateManager.getGistHealth()`), shaped per #1444.
 */
export interface GistHealth {
  /** `'gist'` when the manager is gist-backed (a GistStateStore is attached),
   * `'local'` otherwise — regardless of what the config asks for. */
  mode: 'local' | 'gist';
  /** `null` when healthy: either genuinely local (config agrees) or
   * gist-backed with an armed store. Non-null when this process is not
   * reliably syncing to the Gist. */
  degraded: null | {
    cause: GistHealthDegradedCause;
    /** ISO timestamp when the degradation was first observed, when known
     * (a degraded bootstrap seeds the staleness marker; a
     * configured-but-local manager has no marker to date it by). */
    since?: string;
    /** Whether a later init/recovery attempt can heal this without user
     * action. Both manager-level causes are recoverable by re-running
     * `ensureGistPersistence` with a token (#1415/#1443); a PERMANENT halt
     * (e.g. token lacking the gist scope) surfaces as a thrown
     * ConfigurationError at the surface that attempted recovery — the
     * manager itself cannot observe it, so it never reports false here. */
    recoverable: boolean;
  };
}

/** Cause → human reason, the MCP's former `gistWarningText` mapping promoted
 * to core (#1444). Keep these one-line and append-only: surfaces interpolate
 * them mid-sentence. */
const GIST_DEGRADED_REASON: Record<GistWarningCause, string> = {
  'no-token': 'no GitHub token was available',
  'state-unreadable': 'the state file could not be read',
  'init-fallback': 'initialization hit a transient network failure',
  'configured-but-local': 'this process is running local-only (Gist init has not succeeded)',
  'bootstrap-degraded': 'the Gist bootstrap fell back to the local cache (reads may be stale and pushes are failing)',
};

/**
 * Render the one gist-degradation warning shown by every surface (#1444).
 *
 * Accepts either a known {@link GistWarningCause} or `{ reason }` for the
 * hard-error paths (ConfigurationError repair carve-outs) whose reason text
 * is built from the underlying error.
 *
 * @param cause - Known cause, or a free-form reason for hard init errors.
 * @param opts.retryHint - Optional trailing sentence describing the
 *   surface-specific retry behavior (e.g. the MCP's "Will retry on the next
 *   tool call.").
 */
export function renderGistWarning(
  cause: GistWarningCause | { reason: string },
  opts: { retryHint?: string } = {},
): string {
  const reason = typeof cause === 'string' ? GIST_DEGRADED_REASON[cause] : cause.reason;
  return (
    `Gist persistence is configured but ${reason}; writes are LOCAL-ONLY and may be ` +
    `overwritten by the next successful Gist sync.${opts.retryHint ? ` ${opts.retryHint}` : ''}`
  );
}
