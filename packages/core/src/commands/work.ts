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
 */

import {
  WORK_CLAIM_DEFAULT_TTL_HOURS,
  WORK_CLAIM_MAX_TTL_HOURS,
  checkImplementationClaim,
  getStateManager,
  maybeCheckpoint,
  normalizeWorktreePath,
  type WorkClaim,
  type WorkClaimKind,
} from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { ISSUE_URL_PATTERN, PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

const MODULE = 'work';

/** Longest free-text field (`session`, `branch`, `worktree`, `runId`) accepted, in characters. */
const MAX_FIELD_LENGTH = 500;

/** Control characters (Unicode category Cc), which would break the one-line menu rendering of a claim. */
const CONTROL_CHARACTERS = /\p{Cc}/u;

export interface WorkClaimOptions {
  url: string;
  kind: WorkClaimKind;
  /** Name of the session taking the claim, e.g. `air/20261102T1207`. */
  session: string;
  branch?: string;
  /** Checkout the implementation runs in; required for a local implementation (one implementation per checkout). */
  worktree?: string;
  /** Remote worker run id; required for an implementation with no local worktree. */
  runId?: string;
  /** Claim lifetime in hours; defaults per kind (implementation 24, pr 12). */
  ttlHours?: number;
}

export interface WorkClaimOutput {
  claim: WorkClaim;
  /** A live claim on the same item was replaced (a renewal or a takeover). */
  replaced: boolean;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
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

function validateTtl(ttlHours: number | undefined, kind: WorkClaimKind): number {
  if (ttlHours === undefined) return WORK_CLAIM_DEFAULT_TTL_HOURS[kind];
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
  kind: WorkClaimKind;
  session: string;
  branch?: string;
  worktree?: string;
  runId?: string;
  ttlHours: number;
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
  return { kind, session, branch, worktree, runId, ttlHours: validateTtl(options.ttlHours, kind) };
}

/**
 * Take (or renew) a claim on an item (#1856, #1852).
 *
 * An implementation claim needs a `worktree` or a `runId` so the
 * one-implementation-per-checkout rule has something to compare, and it is
 * refused when `maxConcurrentImplementations` running implementations
 * already exist or another live implementation uses the same checkout. A
 * claim on an item this or another session already holds replaces it
 * (`replaced: true`): renewing extends the expiry, and a takeover is the
 * caller's decision (the workflow asks first).
 *
 * @throws {ValidationError} On a malformed URL or kind mismatch, a missing
 *   location for an implementation, an out-of-range TTL, or when the cap or
 *   the checkout rule blocks the claim.
 */
export async function runWorkClaim(options: WorkClaimOptions): Promise<WorkClaimOutput> {
  const { kind, session, branch, worktree, runId, ttlHours } = validateClaimInput(options);

  const stateManager = getStateManager();
  const now = Date.now();
  if (kind === 'implementation') {
    const conflict = checkImplementationClaim(
      stateManager.getWorkClaims(),
      { url: options.url, worktree },
      stateManager.getState().config.maxConcurrentImplementations,
      now,
    );
    if (conflict) throw new ValidationError(conflict.message);
  }

  const claim: WorkClaim = {
    kind,
    url: options.url,
    session,
    startedAt: isoAt(now),
    expiresAt: isoAt(now + ttlHours * 3_600_000),
    status: 'running',
    ...(branch !== undefined && { branch }),
    ...(worktree !== undefined && { worktree }),
    ...(runId !== undefined && { runId }),
  };
  const isReplaced = stateManager.upsertWorkClaim(claim, now);
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE, () => stateManager.upsertWorkClaim(claim, now));
  return { claim, replaced: isReplaced, ...(gistSyncWarning && { gistSyncWarning }) };
}

/**
 * Mark the live claim on `url` finished (#1856): the implementation's branch
 * is ready to collect. The claim stays until it is released or expires, so
 * the action menu can offer "Collect finished implementations" and search
 * keeps skipping the issue.
 */
export async function runWorkFinish(options: { url: string }): Promise<WorkFinishOutput> {
  validateUrl(options.url);
  const stateManager = getStateManager();
  const at = isoAt(Date.now());
  const claim = stateManager.setWorkClaimStatus(options.url, 'finished', at);
  const gistSyncWarning = claim
    ? await maybeCheckpoint(stateManager, MODULE, () => stateManager.setWorkClaimStatus(options.url, 'finished', at))
    : null;
  return { url: options.url, claim: claim ?? null, ...(gistSyncWarning && { gistSyncWarning }) };
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
  const session = validateField('session', options.session);
  const kind = options.kind === undefined ? undefined : validateKind(options.kind);
  if (options.url !== undefined) validateUrl(options.url);
  if (session === undefined && options.url === undefined) {
    throw new ValidationError('work release needs a URL or --session <name>');
  }
  const selector = { url: options.url, session, kind };
  const stateManager = getStateManager();
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
 * 30 s by the store; a failed fetch serves the cached copy) so a claim another
 * machine pushed since this process loaded state is visible.
 */
export async function runWorkList(): Promise<WorkListOutput> {
  const stateManager = getStateManager();
  if (stateManager.isGistMode()) {
    await stateManager.refreshFromGist();
  } else {
    stateManager.reloadIfChanged();
  }
  const now = Date.now();
  const all = stateManager.getWorkClaims();
  const claims = stateManager.getActiveWorkClaims(now);
  return { claims, expiredCount: all.length - claims.length, now: isoAt(now) };
}
