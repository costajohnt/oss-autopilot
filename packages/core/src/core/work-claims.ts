/**
 * Work claims (#1856, #1852 gap 2): the pure rules over `state.workClaims`.
 *
 * A claim says "this item is being worked on somewhere": an `implementation`
 * claim on an issue while a fix is being built, or a `pr` claim on a PR while
 * a session does Tier 2 work on it. The rules here decide which claims are
 * live, whether a new implementation may start (concurrency cap, one
 * implementation per checkout), and how a live claim shows up in vetting.
 * Persistence lives in `StateManager` (state.ts); the CLI surface is
 * `commands/work.ts`.
 *
 * Expiry is compared against the reading machine's clock. Clock skew between
 * machines is minutes at most, against TTLs of hours, so a claim never looks
 * expired on one machine while another still relies on it in any way that
 * matters; a claim that is re-issued (`work claim` again) gets a fresh
 * `expiresAt`.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import type { WorkClaim, WorkClaimKind } from './state-schema.js';
import { issueRefKey } from './urls.js';

/** Default claim lifetime per kind, in hours. */
export const WORK_CLAIM_DEFAULT_TTL_HOURS: Readonly<Record<WorkClaimKind, number>> = {
  implementation: 24,
  pr: 12,
};

/** Longest TTL `work claim --ttl` accepts, in hours (one week). */
export const WORK_CLAIM_MAX_TTL_HOURS = 168;

/**
 * How long a finished implementation stays collectable, in hours (one week).
 * `work finish` extends `expiresAt` to at least `finishedAt` plus this, so a
 * branch finished late on a 24-hour claim is still offered the next morning.
 */
export const WORK_CLAIM_FINISHED_TTL_HOURS = 168;

/** Identity of the item a claim is on: `owner/repo#number`, or the raw URL when it does not parse. */
export function workClaimKey(url: string): string {
  return issueRefKey(url) ?? url.trim().toLowerCase();
}

/** Whether a claim is still live at `nowMs`. An unparseable `expiresAt` counts as expired. */
export function isWorkClaimActive(claim: Pick<WorkClaim, 'expiresAt'>, nowMs = Date.now()): boolean {
  const expires = Date.parse(claim.expiresAt);
  return Number.isFinite(expires) && expires > nowMs;
}

/** The live claims, in stored order. */
export function activeWorkClaims(claims: readonly WorkClaim[], nowMs = Date.now()): WorkClaim[] {
  return claims.filter((claim) => isWorkClaimActive(claim, nowMs));
}

/** The live claim on `url`, if any. */
export function findWorkClaim(claims: readonly WorkClaim[], url: string, nowMs = Date.now()): WorkClaim | undefined {
  const key = workClaimKey(url);
  return activeWorkClaims(claims, nowMs).find((claim) => workClaimKey(claim.url) === key);
}

/**
 * The live claim on `url` that a session other than `session` holds. Such a
 * claim blocks `work claim` unless the caller passes `--takeover`: a second
 * session must decide to take an item over, never do it by accident.
 */
export function heldByOtherSession(
  claims: readonly WorkClaim[],
  url: string,
  session: string,
  nowMs = Date.now(),
): WorkClaim | undefined {
  const existing = findWorkClaim(claims, url, nowMs);
  if (existing === undefined || existing.session === session) return undefined;
  return existing;
}

/**
 * The claim as `work finish` records it: `finished`, stamped `finishedAt`,
 * and kept at least {@link WORK_CLAIM_FINISHED_TTL_HOURS} past `at` so the
 * branch stays collectable (a longer `expiresAt` already on the claim is kept).
 */
export function finishWorkClaim(claim: WorkClaim, at: string): WorkClaim {
  const extended = new Date(Date.parse(at) + WORK_CLAIM_FINISHED_TTL_HOURS * 3_600_000);
  const current = Date.parse(claim.expiresAt);
  const expiresAt = Number.isFinite(current) && current > extended.getTime() ? claim.expiresAt : extended.toISOString();
  return { ...claim, status: 'finished', finishedAt: at, expiresAt };
}

/** Live implementation claims whose branch is ready to collect. */
export function finishedImplementations(claims: readonly WorkClaim[], nowMs = Date.now()): WorkClaim[] {
  return activeWorkClaims(claims, nowMs).filter((c) => c.kind === 'implementation' && c.status === 'finished');
}

/** Live implementation claims still running. */
export function runningImplementations(claims: readonly WorkClaim[], nowMs = Date.now()): WorkClaim[] {
  return activeWorkClaims(claims, nowMs).filter((c) => c.kind === 'implementation' && c.status === 'running');
}

/** One checkout path for comparison: absolute and normalized (`path.resolve` also drops trailing separators). */
export function normalizeWorktreePath(worktree: string): string {
  return path.resolve(worktree.trim());
}

/** Why a new implementation claim may not start. */
export interface ImplementationClaimConflict {
  reason: 'cap' | 'worktree';
  message: string;
  /** The claims that block the new one. */
  blocking: WorkClaim[];
}

/** The location fields of a claim that identify its checkout. */
export type CheckoutLocation = Pick<WorkClaim, 'worktree' | 'host' | 'machineId'>;

/**
 * Legacy rule for claims written before `machineId` existed: a path only
 * identifies a checkout on one host, so claims from different hosts never
 * share one. A claim without `host` is compared on the path alone.
 */
function isSameHost(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

/**
 * The canonical form of a normalized path on this machine: its real path
 * (symlinks resolved) when it exists here, else the normalized path itself.
 */
function canonicalLocalPath(normalized: string): string {
  try {
    return fs.realpathSync(normalized);
  } catch {
    return normalized;
  }
}

/**
 * Whether `claim`'s checkout is the directory `wanted` (already normalized).
 *
 * When both claims carry a `machineId`, that decides which machine the path
 * is on: different ids never conflict, whatever the path or host, and on the
 * same id the paths are compared canonically ({@link canonicalLocalPath}),
 * so a renamed host (`air` to `air-2`) or a symlinked path still refuses a
 * second implementation in a checkout in use. A claim without an id on
 * either side (written before the field existed, or by a machine whose id
 * file is unreadable) falls back to the hostname rule: the same normalized
 * path on the same `host`, with no real-path resolution, since the stored
 * path may be another machine's.
 */
function isSameCheckout(claim: CheckoutLocation, wanted: string, next: CheckoutLocation): boolean {
  if (!claim.worktree) return false;
  const theirs = normalizeWorktreePath(claim.worktree);
  if (claim.machineId !== undefined && next.machineId !== undefined) {
    if (claim.machineId !== next.machineId) return false;
    return canonicalLocalPath(theirs) === canonicalLocalPath(wanted);
  }
  return isSameHost(claim.host, next.host) && theirs === wanted;
}

/**
 * Check whether an implementation claim may start (#1856): at most
 * `maxConcurrentImplementations` implementations run at once (0 = no cap),
 * and no two live implementations share a checkout (the same directory on
 * the same machine; see {@link isSameCheckout}). A claim already held on the
 * same item is being renewed or taken over, so it never blocks itself.
 * Returns null when the claim may proceed.
 */
export function checkImplementationClaim(
  claims: readonly WorkClaim[],
  next: { url: string } & CheckoutLocation,
  maxConcurrentImplementations: number,
  nowMs = Date.now(),
): ImplementationClaimConflict | null {
  const key = workClaimKey(next.url);
  const others = activeWorkClaims(claims, nowMs).filter(
    (claim) => claim.kind === 'implementation' && workClaimKey(claim.url) !== key,
  );

  if (next.worktree !== undefined) {
    const wanted = normalizeWorktreePath(next.worktree);
    const sharing = others.filter((claim) => isSameCheckout(claim, wanted, next));
    if (sharing.length > 0) {
      const holder = sharing[0];
      return {
        reason: 'worktree',
        blocking: sharing,
        message:
          `Checkout ${wanted} already hosts an implementation of ${holder.url} ` +
          `(session ${holder.session}, ${holder.status}). Use a separate worktree, ` +
          `or finish or release that claim first.`,
      };
    }
  }

  const running = others.filter((claim) => claim.status === 'running');
  if (maxConcurrentImplementations > 0 && running.length >= maxConcurrentImplementations) {
    const list = running.map((claim) => `${claim.url} (session ${claim.session})`).join(', ');
    return {
      reason: 'cap',
      blocking: running,
      message:
        `Implementation cap reached: ${running.length} of ${maxConcurrentImplementations} running (${list}). ` +
        `Collect or release one, or raise it with \`setup --set maxConcurrentImplementations=N\`.`,
    };
  }
  return null;
}

/** Age of a claim as "12 min" / "3 h" / "2 d"; "0 min" for a future or unparseable start. */
export function workClaimAge(claim: Pick<WorkClaim, 'startedAt'>, nowMs = Date.now()): string {
  const started = Date.parse(claim.startedAt);
  const minutes = Number.isFinite(started) ? Math.max(0, Math.floor((nowMs - started) / 60_000)) : 0;
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
}

/** One-line description of a claim for menus and vet reasons, e.g. "implementation claimed in session air/1207 (12 min, running)". */
export function describeWorkClaim(claim: WorkClaim, nowMs = Date.now()): string {
  return `${claim.kind} claimed in session ${claim.session} (${workClaimAge(claim, nowMs)}, ${claim.status})`;
}

/**
 * Vet-side dedup (#1856): an issue under a live implementation claim is
 * skipped the way an issue with a linked PR is. Returns the vet fields to
 * merge, or null when the issue is unclaimed. The skip reason contains the
 * word "claimed" so `vet-list`'s status classifier files it as claimed.
 */
export function workClaimVetFields(
  claims: readonly WorkClaim[],
  issueUrl: string,
  nowMs = Date.now(),
): { recommendation: 'skip'; reasonsToSkip: string[]; workClaim: WorkClaim } | null {
  const claim = findWorkClaim(claims, issueUrl, nowMs);
  if (!claim || claim.kind !== 'implementation') return null;
  return {
    recommendation: 'skip',
    reasonsToSkip: [`Already being implemented: ${describeWorkClaim(claim, nowMs)}`],
    workClaim: claim,
  };
}
