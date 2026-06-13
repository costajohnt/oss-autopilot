/**
 * GistSyncCoordinator — the dashboard server's gist-sync lifecycle state machine.
 *
 * Extracted from dashboard-server.ts (#1457). Owns the five pieces of gist
 * lifecycle state (pending push warnings, loss notices, degraded mutation
 * count, recovery halt reason, recovery throttle stamp) plus the live
 * StateManager reference, which a degraded recovery replaces (#1433). The
 * HTTP handlers consume it as a collaborator; nothing here touches req/res.
 */

import {
  getStateManager,
  getGitHubToken,
  maybeCheckpoint,
  ensureGistPersistence,
  type StateManager,
  type GistHealth,
} from '../core/index.js';
import { errorMessage, ConfigurationError } from '../core/errors.js';
import { warn } from '../core/logger.js';

const GIST_DEGRADED_WARNING =
  'Gist persistence is configured but this dashboard process is running LOCAL-ONLY; ' +
  'changes made here will NOT sync and may be overwritten by the next successful Gist read. ' +
  'Recovery is retried automatically.';

// #1443: a degraded bootstrap disarms the store, so "the next successful
// Gist read" can never arrive on its own — maybeRecoverGist re-bootstraps
// (the gate below treats this state as recoverable), which is the retry
// this banner now promises.
const GIST_STALE_BOOTSTRAP_WARNING =
  'Gist persistence is active but the last Gist read fell back to the local cache; ' +
  'data shown may be stale. Recovery is retried automatically.';

// Recovery throttling + halt (#1433 review): a PERMANENT failure (token
// lacks gist scope, corrupt Gist) must not turn every dashboard poll into
// a doomed GitHub round trip for the life of the server, and its root
// cause must reach the banner — the detached spawn discards stderr.
const RECOVERY_RETRY_INTERVAL_MS = 30_000;

export class GistSyncCoordinator {
  // Mutable (#1433): a degraded gist recovery replaces the core singleton, and
  // this long-lived server must re-resolve its reference or every handler
  // keeps using the orphaned local manager.
  private manager: StateManager;

  // Gist checkpoint warnings from dashboard mutations (#1417). DELIBERATELY
  // separate from cachedPartialFailures: fetch failures clear on a successful
  // PULL, but a gist-sync warning means an un-pushed mutation, and a pull is
  // exactly the event that can destroy it (refreshFromGist wholesale-replaces
  // state). These clear only when a checkpoint PUSH succeeds.
  private pendingGistSyncWarnings: string[] = [];

  private lastRecoveryAttemptAt = 0;
  private recoveryHaltedReason: string | null = null;

  // Mutations acknowledged while degraded (#1433 review): a successful
  // recovery bootstraps FROM the existing Gist, which reverts them — the
  // user must get a retrospective notice, not just the prospective banner
  // that clears at the exact moment of the loss. Cleared on a successful
  // full refresh (by then the user has seen the notice across the window).
  private degradedMutationCount = 0;
  private recoveryLossNotices: string[] = [];

  constructor(
    /** Token from server options; falls back to getGitHubToken() per recovery attempt. */
    private readonly token: string | null,
    /** Logger module tag (kept identical to the server's so log output is unchanged). */
    private readonly module: string,
  ) {
    this.manager = getStateManager();
  }

  /** The live state manager. Always read through this accessor — a degraded
   * gist recovery replaces the core singleton mid-flight (#1433). */
  get stateManager(): StateManager {
    return this.manager;
  }

  /** Record a mutation's checkpoint outcome. `null` means the push succeeded
   * (or local mode) — and a successful push carries the FULL current state,
   * so any previously pending warning is resolved with it. */
  recordGistSyncOutcome(warning: string | null): void {
    if (warning === null) {
      this.pendingGistSyncWarnings = [];
      return;
    }
    if (!this.pendingGistSyncWarnings.includes(warning)) {
      this.pendingGistSyncWarnings.push(warning);
    }
  }

  /** Merge pending gist-sync warnings into a partialFailures payload for the
   * SPA banner without coupling their lifecycles. */
  withPendingGistWarnings(failures: string[] | undefined): string[] | undefined {
    const extras = [...this.pendingGistSyncWarnings, ...this.recoveryLossNotices];
    if (this.gistConfiguredButLocal()) {
      extras.push(
        this.recoveryHaltedReason === null
          ? GIST_DEGRADED_WARNING
          : `Gist persistence is configured but recovery FAILED permanently: ${this.recoveryHaltedReason} — ` +
              'fix the Gist setup (check the token gist scope, or run state-show), then restart the dashboard.',
      );
    } else if (this.gistBootstrapDegraded()) {
      // Same halt surfacing as the local-only branch (#1443): a permanent
      // recovery failure must reach the banner here too, or the stale-data
      // retry promise in GIST_STALE_BOOTSTRAP_WARNING would dangle forever
      // with no visible reason.
      extras.push(
        this.recoveryHaltedReason === null
          ? GIST_STALE_BOOTSTRAP_WARNING
          : `Gist persistence is degraded and recovery FAILED permanently: ${this.recoveryHaltedReason} — ` +
              'fix the Gist setup (check the token gist scope, or run state-show), then restart the dashboard.',
      );
    }
    if (extras.length === 0) return failures;
    const base = failures ?? [];
    return [...base, ...extras.filter((w) => !base.includes(w))];
  }

  /** Push-before-pull (#1417): an un-pushed mutation would be silently
   * reverted by the next Gist pull. Retry the checkpoint first so a recovered
   * network turns the pending warning into a real push before any pull runs.
   * No-op when nothing is pending. */
  async flushPendingGistSync(): Promise<void> {
    if (this.pendingGistSyncWarnings.length === 0) return;
    this.recordGistSyncOutcome(await maybeCheckpoint(this.manager, this.module));
  }

  /** One health snapshot from the one source (#1444). Defensive: this is an
   * advisory probe that runs on EVERY request path (rebuilds, recovery
   * gates). A state failure has its own handling wherever state is actually
   * consumed — the probe must not become a new crash surface in front of it
   * (#994's stale-serving path). */
  probeGistHealth(): GistHealth | null {
    try {
      return this.manager.getGistHealth();
    } catch (err) {
      warn(this.module, `Degraded-gist probe failed (treating as not degraded): ${errorMessage(err)}`);
      return null;
    }
  }

  /** True while the config asks for gist but this process's manager is
   * local-only (#1433) — the degraded window in which every dashboard
   * mutation is acknowledged and then clobbered by the next pull. */
  gistConfiguredButLocal(): boolean {
    const health = this.probeGistHealth();
    return health !== null && health.mode === 'local' && health.degraded !== null;
  }

  /** Gist-backed but the bootstrap itself fell back to the local cache —
   * reads may be stale even though isGistMode() is true (#1433 review). */
  gistBootstrapDegraded(): boolean {
    const health = this.probeGistHealth();
    return health !== null && health.mode === 'gist' && health.degraded !== null;
  }

  /** A successful PULL (refresh, or a recovery re-bootstrap) wholesale-
   * replaces in-memory state. If push warnings are still pending at that
   * moment, the mutations they describe are gone from the working state and
   * a LATER push can never carry them — so an unrelated future push must not
   * be allowed to "resolve" them (#1443). Convert the prospective warnings
   * into a retrospective loss notice. Lifecycle invariants from #1417/#1433
   * are unchanged: pending warnings still clear only via recordGistSyncOutcome
   * on a successful push, and loss notices still clear at the start of the
   * next refresh cycle. */
  convertPendingWarningsToLossNotices(): void {
    if (this.pendingGistSyncWarnings.length === 0) return;
    this.recoveryLossNotices.push(
      `A Gist read replaced local state while ${this.pendingGistSyncWarnings.length} change(s) were still un-pushed — ` +
        'they were NOT synced to the Gist and may have been reverted in this view. Re-apply anything missing.',
    );
    this.pendingGistSyncWarnings = [];
  }

  /** Pull from the Gist, converting still-pending push warnings into a loss
   * notice when the pull actually replaced state (#1443). All dashboard pull
   * sites go through here; callers flush pending pushes first (#1417), so a
   * warning that is still pending at pull time means the flush failed. */
  async pullFromGist(): Promise<boolean> {
    const refreshed = await this.manager.refreshFromGist();
    if (refreshed) this.convertPendingWarningsToLossNotices();
    return refreshed;
  }

  /** Re-attempt gist init while degraded (#1433). The serve process used to
   * bootstrap exactly once at CLI preAction — with its stderr discarded by
   * the detached spawn — and never retry, so one blip at startup meant
   * local-only writes for the server's lifetime. Never throws. Transient
   * failures retry no more often than RECOVERY_RETRY_INTERVAL_MS; permanent
   * (ConfigurationError-class) failures halt retries and surface the reason
   * in the banner.
   *
   * Covers BOTH degraded shapes (#1443): a local-only manager under a gist
   * config, and a gist-backed manager whose bootstrap fell back to the local
   * cache (disarmed store — refreshFromGist can never heal it on its own). */
  async maybeRecoverGist(): Promise<void> {
    // One probe covers both degraded shapes — health.degraded is non-null
    // for configured-but-local AND bootstrap-degraded (#1444).
    if (this.probeGistHealth()?.degraded == null) return;
    if (this.recoveryHaltedReason !== null) return;
    const now = Date.now();
    if (now - this.lastRecoveryAttemptAt < RECOVERY_RETRY_INTERVAL_MS) return;
    const currentToken = this.token || getGitHubToken();
    // A token-less probe is free (the auth cache answers instantly) and must
    // not burn the retry window — stamp only when a real attempt starts.
    if (!currentToken) return;
    this.lastRecoveryAttemptAt = now;
    try {
      await ensureGistPersistence(currentToken);
      // The upgrade replaced the core singleton — re-resolve our reference.
      this.manager = getStateManager();
      // Genuinely armed only: a retry can resolve via ANOTHER degraded
      // bootstrap (gist-backed, store disarmed) — that is not a recovery
      // and must not produce a recovery notice (#1443).
      const health = this.manager.getGistHealth();
      const recovered = health.mode === 'gist' && health.degraded === null;
      if (recovered) {
        // The re-bootstrap pulled the existing Gist: un-pushed mutations
        // from the degraded window are not in the replacement state.
        this.convertPendingWarningsToLossNotices();
      }
      if (recovered && this.degradedMutationCount > 0) {
        this.recoveryLossNotices.push(
          `Gist persistence recovered, but ${this.degradedMutationCount} change(s) made while degraded were ` +
            'saved locally only and were NOT merged into the Gist — they may have been reverted in this view. ' +
            'Re-apply anything missing.',
        );
        this.degradedMutationCount = 0;
      }
    } catch (err) {
      // ConfigurationError-class failures are permanent until the user acts
      // (#1202 semantics) — stop hammering GitHub and say WHY in the banner.
      if (err instanceof ConfigurationError) {
        this.recoveryHaltedReason = errorMessage(err);
      }
      warn(this.module, `Gist recovery attempt failed: ${errorMessage(err)}`);
    }
  }

  /** An external config edit may BE the fix for a permanently-halted
   * recovery (new token scope, repaired gist id) — give it one fresh
   * attempt cycle (#1433 pass-2). */
  unhaltRecovery(): void {
    this.recoveryHaltedReason = null;
  }

  /** Count mutations acknowledged while degraded (#1433): a later recovery
   * bootstraps from the existing Gist and reverts them, and the loss
   * notice needs to know whether there is anything to lose. */
  recordMutationWhileDegraded(): void {
    if (this.gistConfiguredButLocal()) this.degradedMutationCount++;
  }

  /** Retire pre-existing loss notices — by the time a refresh cycle starts
   * they have been visible across the degraded window (#1433 pass-2). */
  clearRecoveryLossNotices(): void {
    this.recoveryLossNotices = [];
  }
}
