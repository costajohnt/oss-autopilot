/**
 * PR follow-up history helpers (#1277).
 *
 * Centralizes the read/write logic for `state.prFollowUpHistory`.
 * Used by `workflows/dormant-pr-follow-up.md` to enforce the
 * one-follow-up-per-timeframe rule documented in
 * `skills/pr-etiquette/SKILL.md`.
 *
 * Pure functions — callers manage state I/O.
 */

import type { AgentState } from './state-schema.js';
import type { FollowUpEntry } from './state-schema.js';

export type FollowUpTier = 'light_check_in' | 'direct_check_in' | 'final_check_in';

/**
 * Tier window in days. The "no second ping in the same window" rule
 * uses this to decide whether a recent follow-up still locks out the
 * next draft. Sourced from `skills/pr-etiquette/SKILL.md`.
 */
export const TIER_WINDOW_DAYS: Record<FollowUpTier, number> = {
  light_check_in: 7,
  direct_check_in: 14,
  final_check_in: 30,
};

/**
 * Read the existing follow-up entries for a PR. Returns an empty
 * array when no entries exist or when the state field is unset.
 */
export function getFollowUpHistory(state: AgentState, prUrl: string): FollowUpEntry[] {
  return state.prFollowUpHistory?.[prUrl] ?? [];
}

/**
 * Find the most recent entry, or null when there are none. Used by
 * the workflow's pre-draft gate.
 */
export function lastFollowUp(state: AgentState, prUrl: string): FollowUpEntry | null {
  const entries = getFollowUpHistory(state, prUrl);
  if (entries.length === 0) return null;
  // Newest by timestamp wins. Defensive sort because the persistence
  // path doesn't guarantee insertion order across machines.
  return [...entries].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
}

/**
 * Whether a follow-up of the given tier was drafted within the
 * tier's own window. The workflow uses this to surface a warning
 * before the user drafts a second ping in the same window. Different
 * tiers are always allowed (escalating light → direct → final).
 */
export function isWithinTierWindow(
  state: AgentState,
  prUrl: string,
  tier: FollowUpTier,
  now: Date = new Date(),
): boolean {
  const last = lastFollowUp(state, prUrl);
  if (!last) return false;
  if (last.tier !== tier) return false;
  const ageMs = now.getTime() - Date.parse(last.timestamp);
  if (Number.isNaN(ageMs)) return false;
  const windowMs = TIER_WINDOW_DAYS[tier] * 86400000;
  return ageMs < windowMs;
}

/**
 * Record a new follow-up entry. Returns the next state; callers
 * decide when to persist.
 */
export function recordFollowUp(state: AgentState, prUrl: string, entry: FollowUpEntry): AgentState {
  const next: AgentState = {
    ...state,
    prFollowUpHistory: { ...(state.prFollowUpHistory ?? {}) },
  };
  const list = next.prFollowUpHistory![prUrl] ? [...next.prFollowUpHistory![prUrl]] : [];
  list.push(entry);
  next.prFollowUpHistory![prUrl] = list;
  return next;
}
