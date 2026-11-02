/**
 * The daily run's dismissed-issue filter and the fresh-baseline batch helper
 * it persists through. Split out of daily.ts so the filter can be exercised
 * against a real StateManager (dismiss, resurface, reload from disk) without
 * mocking the whole daily pipeline.
 */

import { getStateManager, isCoveredByDismiss, type CommentedIssue } from '../core/index.js';
import { warn } from '../core/logger.js';
import type { DailyWarning } from '../formatters/json.js';
import { recordWarning } from './daily-warnings.js';

const MODULE = 'daily';

type StateManagerLike = Pick<
  ReturnType<typeof getStateManager>,
  'reloadIfChanged' | 'batch' | 'getIssueDismissedAt' | 'undismissIssue'
>;

/**
 * Run a batch against a baseline that is fresh as of right now.
 *
 * A daily run spends tens of seconds on the network between loading state and
 * each of its saves. If the dashboard, `move`, or another CLI call writes
 * state.json in that time, the compare-and-swap in `saveState` rejects the
 * save, and because the baseline never moved, every later batch in the run is
 * rejected too: repo scores, analytics, the merged/closed ledger and lastDigest
 * were all dropped, surfacing only as warnings. Reloading first picks up the
 * other writer's change and shrinks the window to the batch itself.
 *
 * Only safe where the callback reads state live through the manager, as the
 * batches in daily.ts do. A callback that writes from a snapshot taken
 * earlier would overwrite the other writer's fields, which is why this is not
 * done inside `StateManager.batch` for every caller.
 */
export function batchOnFreshBaseline(
  stateManager: Pick<StateManagerLike, 'reloadIfChanged' | 'batch'>,
  fn: () => void,
): void {
  stateManager.reloadIfChanged();
  stateManager.batch(fn);
}

/**
 * Drop the commented issues the user dismissed, unless a reply newer than
 * the dismiss arrived: that issue comes back and its dismiss record is
 * removed, so the dashboard (which applies the same `isCoveredByDismiss`
 * comparison, #1862) and the next run agree. Runs inside one fresh-baseline
 * batch so every auto-undismiss lands in a single disk write; a persistence
 * failure is recorded under the `dismiss-filter` phase and the issues are
 * still returned.
 */
export function filterDismissedIssues(
  stateManager: StateManagerLike,
  issues: CommentedIssue[],
  warnings: DailyWarning[],
): CommentedIssue[] {
  let filtered: CommentedIssue[] = [];
  try {
    batchOnFreshBaseline(stateManager, () => {
      filtered = issues.filter((issue) => shouldKeep(stateManager, issue, warnings));
    });
  } catch (error) {
    recordWarning(warnings, 'dismiss-filter', 'persist auto-undismiss state', error);
  }
  return filtered;
}

/** Whether `issue` stays in the digest; undismisses it when a newer reply arrived. */
function shouldKeep(stateManager: StateManagerLike, issue: CommentedIssue, warnings: DailyWarning[]): boolean {
  const dismissedAt = stateManager.getIssueDismissedAt(issue.url);
  if (!dismissedAt) return true; // Not dismissed — include
  if (issue.status !== 'new_response') return false; // Still dismissed
  if (Number.isNaN(Date.parse(issue.lastResponseAt)) || Number.isNaN(Date.parse(dismissedAt))) {
    // Invalid timestamp — fail open (include issue to be safe) without
    // permanently removing dismiss record (may be a transient data issue)
    warn(MODULE, `Invalid timestamp in dismiss check for ${issue.url}, including issue`);
    return true;
  }
  // Still dismissed when the last response is at or before the dismiss timestamp.
  if (isCoveredByDismiss(dismissedAt, issue.lastResponseAt)) return false;
  // New activity after dismiss — auto-undismiss and resurface
  warn(
    MODULE,
    `Auto-undismissing issue ${issue.url}: new response at ${issue.lastResponseAt} after dismiss at ${dismissedAt}`,
  );
  undismissSafely(stateManager, issue.url, warnings);
  return true;
}

function undismissSafely(stateManager: StateManagerLike, url: string, warnings: DailyWarning[]): void {
  try {
    stateManager.undismissIssue(url);
  } catch (error) {
    recordWarning(warnings, 'dismiss-filter', `persist auto-undismiss for ${url}`, error);
  }
}
