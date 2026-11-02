/**
 * Work claim commands (#1856, #1852 gap 2): `work claim`, `work finish`,
 * `work release`, `work list`.
 *
 * A claim records that some session is working an item, so other sessions
 * (same machine or another one via the Gist) see it instead of starting the
 * same work. `implementation` claims sit on issue URLs while a fix is built
 * in the background; `pr` claims sit on PR URLs while a session does Tier 2
 * work there. Rules live in `core/work-claims.ts`; this file validates input,
 * applies the state mutation and pushes it to the Gist.
 *
 * Each `run*` has a `*Work(stateManager, options)` twin that takes the
 * manager explicitly, so the Gist concurrency tests can drive two machines
 * through the real command path.
 */

import os from 'node:os';
import {
  WORK_CLAIM_DEFAULT_TTL_HOURS,
  WORK_CLAIM_FINISHED_TTL_HOURS,
  WORK_CLAIM_MAX_TTL_HOURS,
  checkImplementationClaim,
  describeWorkClaim,
  findWorkClaim,
  getStateManager,
  heldByOtherSession,
  maybeCheckpoint,
  normalizeWorktreePath,
  type StateManager,
  type WorkClaim,
  type WorkClaimKind,
} from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { buildStalenessWarning, type DailyWarning } from '../formatters/json.js';
import { ISSUE_URL_PATTERN, PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

const MODULE = 'work';

/** Longest free-text field (`session`, `branch`, `worktree`, `runId`) accepted, in characters. */
const MAX_FIELD_LENGTH = 500;

/** Control characters (Unicode category Cc), which would break the one-line menu rendering of a claim. */
const CONTROL_CHARACTERS = /\p{Cc}/u;

export interface WorkClaimOptions {
  url: string;
  kind: WorkClaimKind;
  /** Name of the session taking the claim, e.g. `air/20261102T120733-3f9a`. */
  session: string;
  branch?: string;
  /** Checkout the implementation runs in; required for a local implementation (one implementation per checkout). */
  worktree?: string;
  /** Remote worker run id; required for an implementation with no local worktree. */
  runId?: string;
  /** Claim lifetime in hours; defaults per kind (implementation 24, pr 12). */
  ttlHours?: number;
  /** Replace a live claim another session holds on the item. Without it such a claim is refused. */
  takeover?: boolean;
}

/** What `work claim` did to the item: nothing was there, this session renewed its own claim, or another session's claim was replaced. */
export type WorkClaimOutcome = 'claimed' | 'renewed' | 'took-over';

export interface WorkClaimOutput {
  claim: WorkClaim;
  outcome: WorkClaimOutcome;
  /**
   * False when the claim exists on this machine only: the Gist push failed
   * (`gistSyncWarning`) or Gist persistence is degraded. Other machines
   * cannot see it, so a workflow should not treat the item as reserved.
   */
  synced: boolean;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

export interface WorkFinishOptions {
  url: string;
  /** When given, the live claim must belong to this session; a mismatch is refused instead of finishing someone else's run. */
  session?: string;
}

export interface WorkFinishOutput {
  url: string;
  /** The claim as marked finished, or null when no live claim exists on the item. */
  claim: WorkClaim | null;
  gistSyncWarning?: string;
}

export interface WorkReleaseOptions {
  url?: string;
  /** Release every claim this session holds (optionally only `kind`). */
  session?: string;
  kind?: WorkClaimKind;
}

export interface WorkReleaseOutput {
  /** URLs of the live claims released, in stored order. */
  released: string[];
  gistSyncWarning?: string;
}

export interface WorkListOutput {
  /** Live claims, in stored order. */
  claims: WorkClaim[];
  /** Stored claims past `expiresAt`; pruned by the next claim write. */
  expiredCount: number;
  /** When the list was computed; `expiresAt` values compare against this. */
  now: string;
  /** Set when the list comes from a stale copy: the Gist refresh failed, so another machine's claims may be missing (#1193). */
  warnings?: DailyWarning[];
}

function isoAt(ms: number): string {
  const at = new Date(ms);
  return at.toISOString();
}

function validateField(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ValidationError(`--${name} must not be empty`);
  if (trimmed.length > MAX_FIELD_LENGTH)
    throw new ValidationError(`--${name} is longer than ${MAX_FIELD_LENGTH} characters`);
  if (CONTROL_CHARACTERS.test(trimmed)) throw new ValidationError(`--${name} must not contain control characters`);
  return trimmed;
}

function validateKind(kind: string): WorkClaimKind {
  if (kind === 'implementation' || kind === 'pr') return kind;
  throw new ValidationError(`--kind must be "implementation" or "pr", got "${kind}"`);
}

function validateTtl(ttlHours: number | undefined): number | undefined {
  if (ttlHours === undefined) return undefined;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > WORK_CLAIM_MAX_TTL_HOURS) {
    throw new ValidationError(`--ttl must be a number of hours between 0 and ${WORK_CLAIM_MAX_TTL_HOURS}`);
  }
  return ttlHours;
}

/** Validate a claim's URL against its kind: implementations sit on issues, pr claims on PRs. */
function validateClaimUrl(url: string, kind: WorkClaimKind): void {
  validateUrl(url);
  if (kind === 'pr') {
    validateGitHubUrl(url, PR_URL_PATTERN, 'PR');
  } else {
    validateGitHubUrl(url, ISSUE_URL_PATTERN, 'issue');
  }
}

/** The validated, trimmed claim input; `worktree` is normalized for comparison. */
interface ClaimInput {
  url: string;
  kind: WorkClaimKind;
  session: string;
  branch?: string;
  worktree?: string;
  /** Hostname of this machine, set with `worktree` so the same path on another machine is not a conflict. */
  host?: string;
  runId?: string;
  /** Explicit `--ttl`; the default depends on the kind and on whether a finished claim is being renewed. */
  ttlHours?: number;
  takeover: boolean;
}

function validateClaimInput(options: WorkClaimOptions): ClaimInput {
  const kind = validateKind(options.kind);
  validateClaimUrl(options.url, kind);
  const session = validateField('session', options.session);
  if (session === undefined) throw new ValidationError('--session is required');
  const branch = validateField('branch', options.branch);
  const runId = validateField('run-id', options.runId);
  const rawWorktree = validateField('worktree', options.worktree);
  const worktree = rawWorktree === undefined ? undefined : normalizeWorktreePath(rawWorktree);
  if (kind === 'implementation' && worktree === undefined && runId === undefined) {
    throw new ValidationError(
      'An implementation claim needs --worktree (local checkout) or --run-id (remote worker run)',
    );
  }
  const host = worktree === undefined ? undefined : os.hostname();
  const ttlHours = validateTtl(options.ttlHours);
  const isTakeover = options.takeover === true;
  return { kind, session, branch, worktree, host, runId, ttlHours, url: options.url, takeover: isTakeover };
}

/**
 * Why the claim may not be recorded against the manager's current claims:
 * another session holds the item (and `takeover` was not passed), the
 * implementation cap is reached, or the checkout hosts another
 * implementation. Null when it may proceed. Evaluated on the local state
 * first and again on the Gist's copy after a conflict, so a claim another
 * machine recorded first is never overwritten.
 */
function claimRefusal(stateManager: StateManager, input: ClaimInput, nowMs: number): string | null {
  const claims = stateManager.getWorkClaims();
  const holder = heldByOtherSession(claims, input.url, input.session, nowMs);
  if (holder && !input.takeover) {
    return (
      `${input.url} is already claimed: ${describeWorkClaim(holder, nowMs)}. ` +
      `Pass --takeover (takeover: true) to replace that claim.`
    );
  }
  if (input.kind === 'implementation') {
    const cap = stateManager.getState().config.maxConcurrentImplementations;
    const conflict = checkImplementationClaim(claims, input, cap, nowMs);
    if (conflict) return conflict.message;
  }
  return null;
}

/**
 * Build the claim to store. Renewing this session's own `finished`
 * implementation keeps it finished (and collectable for the finished TTL):
 * a renewal must not quietly turn a branch that is ready to collect back
 * into a run in progress. To start over, release the claim first.
 */
function buildClaim(input: ClaimInput, existing: WorkClaim | undefined, nowMs: number): WorkClaim {
  const finishedOwn = isOwnFinishedClaim(input, existing) ? existing : undefined;
  const ttlHours =
    input.ttlHours ?? (finishedOwn ? WORK_CLAIM_FINISHED_TTL_HOURS : WORK_CLAIM_DEFAULT_TTL_HOURS[input.kind]);
  const { branch, worktree, host, runId } = input;
  return {
    kind: input.kind,
    url: input.url,
    session: input.session,
    startedAt: isoAt(nowMs),
    expiresAt: isoAt(nowMs + ttlHours * 3_600_000),
    status: finishedOwn ? 'finished' : 'running',
    ...(branch !== undefined && { branch }),
    ...(worktree !== undefined && { worktree }),
    ...(host !== undefined && { host }),
    ...(runId !== undefined && { runId }),
    ...(finishedOwn?.finishedAt !== undefined && { finishedAt: finishedOwn.finishedAt }),
  };
}

/** Whether `existing` is this session's own finished claim of the same kind (a renewal keeps it finished). */
function isOwnFinishedClaim(input: ClaimInput, existing: WorkClaim | undefined): existing is WorkClaim {
  return (
    existing !== undefined &&
    existing.session === input.session &&
    existing.kind === input.kind &&
    existing.status === 'finished'
  );
}

/** What recording `claim` over `existing` amounts to. */
function outcomeFor(existing: WorkClaim | undefined, session: string): WorkClaimOutcome {
  if (existing === undefined) return 'claimed';
  return existing.session === session ? 'renewed' : 'took-over';
}

/**
 * Take (or renew) a claim on an item (#1856, #1852).
 *
 * An implementation claim needs a `worktree` or a `runId` so the
 * one-implementation-per-checkout rule has something to compare, and it is
 * refused when `maxConcurrentImplementations` running implementations
 * already exist or another live implementation uses the same checkout on
 * this host. A live claim another session holds is refused unless `takeover`
 * is set (the workflow asks first); this session's own claim is renewed.
 *
 * In Gist mode the checks run again on the Gist's copy when the push
 * conflicts with another machine: if that copy refuses the claim, nothing is
 * recorded and the refusal is thrown. The claim is `synced: false` when it
 * exists locally only.
 *
 * @throws {ValidationError} On a malformed URL or kind mismatch, a missing
 *   location for an implementation, an out-of-range TTL, or when another
 *   session's claim, the cap or the checkout rule blocks the claim.
 */
export async function runWorkClaim(options: WorkClaimOptions): Promise<WorkClaimOutput> {
  return claimWork(getStateManager(), options);
}

/** {@link runWorkClaim} against an explicit manager. */
export async function claimWork(stateManager: StateManager, options: WorkClaimOptions): Promise<WorkClaimOutput> {
  const input = validateClaimInput(options);
  const now = Date.now();
  const refusedLocally = claimRefusal(stateManager, input, now);
  if (refusedLocally) throw new ValidationError(refusedLocally);

  const existing = findWorkClaim(stateManager.getWorkClaims(), input.url, now);
  const claim = buildClaim(input, existing, now);
  const outcome = outcomeFor(existing, input.session);

  // The reapply (pre-push and after a Gist conflict) re-checks on whatever
  // state is current. On the local state it sees this claim and passes; on
  // a refreshed Gist copy it may find another machine got there first, and
  // then it records the refusal instead of writing over that claim.
  const remote: Refusal = { message: null };
  const apply = (): void => {
    remote.message = claimRefusal(stateManager, input, now);
    if (remote.message === null) stateManager.upsertWorkClaim(claim, now);
  };
  apply();
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE, apply);
  if (remote.message !== null) {
    throw new ValidationError(`${remote.message} (recorded on another machine first; this claim was not saved)`);
  }
  const isSynced = gistSyncWarning === null && stateManager.getGistHealth().degraded === null;
  return { claim, outcome, synced: isSynced, ...(gistSyncWarning && { gistSyncWarning }) };
}

/** A refusal found while (re)applying a mutation; a closure cannot throw it (conflict recovery would swallow it), so it is carried out. */
interface Refusal {
  message: string | null;
}

/**
 * Mark the live claim on `url` finished (#1856): the implementation's branch
 * is ready to collect. The claim stays (with its expiry extended to at least
 * a week) until it is released or expires, so the action menu can offer
 * "Collect finished implementations" and search keeps skipping the issue.
 * With `session`, a claim another session holds is refused rather than
 * finished on its behalf.
 *
 * @throws {ValidationError} When `session` is given and the live claim belongs to another session.
 */
export async function runWorkFinish(options: WorkFinishOptions): Promise<WorkFinishOutput> {
  return finishWork(getStateManager(), options);
}

/** {@link runWorkFinish} against an explicit manager. */
export async function finishWork(stateManager: StateManager, options: WorkFinishOptions): Promise<WorkFinishOutput> {
  validateUrl(options.url);
  const session = validateField('session', options.session);
  const now = Date.now();
  const at = isoAt(now);

  const mismatch = (): string | null => {
    const existing = findWorkClaim(stateManager.getWorkClaims(), options.url, now);
    if (existing === undefined || session === undefined || existing.session === session) return null;
    return `The claim on ${options.url} belongs to session ${existing.session}, not ${session}; it was not marked finished.`;
  };
  const refusal: Refusal = { message: mismatch() };
  if (refusal.message !== null) throw new ValidationError(refusal.message);

  const result: { claim: WorkClaim | null } = { claim: null };
  const apply = (): void => {
    refusal.message = mismatch();
    if (refusal.message === null) result.claim = stateManager.finishWorkClaim(options.url, at, now) ?? null;
  };
  apply();
  const gistSyncWarning = result.claim ? await maybeCheckpoint(stateManager, MODULE, apply) : null;
  if (refusal.message !== null) throw new ValidationError(refusal.message);
  return { url: options.url, claim: result.claim, ...(gistSyncWarning && { gistSyncWarning }) };
}

/**
 * Drop claims (#1856, #1852): the claim on `url`, or every claim `session`
 * holds (Session End releases that session's `pr` claims with
 * `{ session, kind: 'pr' }`). Releasing an item nobody holds is not an
 * error: `released` is simply empty.
 *
 * @throws {ValidationError} When neither `url` nor `session` is given.
 */
export async function runWorkRelease(options: WorkReleaseOptions): Promise<WorkReleaseOutput> {
  return releaseWork(getStateManager(), options);
}

/** {@link runWorkRelease} against an explicit manager. */
export async function releaseWork(stateManager: StateManager, options: WorkReleaseOptions): Promise<WorkReleaseOutput> {
  const session = validateField('session', options.session);
  const kind = options.kind === undefined ? undefined : validateKind(options.kind);
  if (options.url !== undefined) validateUrl(options.url);
  if (session === undefined && options.url === undefined) {
    throw new ValidationError('work release needs a URL or --session <name>');
  }
  const selector = { url: options.url, session, kind };
  const released = stateManager.releaseWorkClaims(selector);
  const gistSyncWarning =
    released.length > 0
      ? await maybeCheckpoint(stateManager, MODULE, () => stateManager.releaseWorkClaims(selector))
      : null;
  return { released, ...(gistSyncWarning && { gistSyncWarning }) };
}

/**
 * The live claims (#1856). Read-only: expired claims are counted, not
 * pruned. In Gist mode the state is refreshed first (throttled to once per
 * 30 s by the store; a failed fetch serves the cached copy and sets a
 * `warnings` entry) so a claim another machine pushed since this process
 * loaded state is visible.
 */
export async function runWorkList(): Promise<WorkListOutput> {
  return listWork(getStateManager());
}

/** {@link runWorkList} against an explicit manager. */
export async function listWork(stateManager: StateManager): Promise<WorkListOutput> {
  if (stateManager.isGistMode()) {
    await stateManager.refreshFromGist();
  } else {
    stateManager.reloadIfChanged();
  }
  const now = Date.now();
  const all = stateManager.getWorkClaims();
  const claims = stateManager.getActiveWorkClaims(now);
  const staleness = stateManager.getStateStaleness();
  return {
    claims,
    expiredCount: all.length - claims.length,
    now: isoAt(now),
    ...(staleness && { warnings: [buildStalenessWarning(staleness)] }),
  };
}
