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

/**
 * Check whether an implementation claim may start (#1856): at most
 * `maxConcurrentImplementations` implementations run at once (0 = no cap),
 * and no two live implementations share a checkout. A claim already held on
 * the same item is being renewed, so it never blocks itself. Returns null
 * when the claim may proceed.
 */
export function checkImplementationClaim(
  claims: readonly WorkClaim[],
  next: { url: string; worktree?: string },
  maxConcurrentImplementations: number,
  nowMs = Date.now(),
): ImplementationClaimConflict | null {
  const key = workClaimKey(next.url);
  const others = activeWorkClaims(claims, nowMs).filter(
    (claim) => claim.kind === 'implementation' && workClaimKey(claim.url) !== key,
  );

  if (next.worktree !== undefined) {
    const wanted = normalizeWorktreePath(next.worktree);
    const sharing = others.filter((claim) => claim.worktree && normalizeWorktreePath(claim.worktree) === wanted);
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
