/**
 * Dismiss/Undismiss commands
 * Manages dismissing issue notifications without posting a comment.
 * Dismissed URLs resurface automatically when new responses arrive after the dismiss timestamp.
 *
 * PR URLs are accepted too: dismissing a merged PR's URL declines the
 * "merged PR with maintainer notes" nudge (#1861), and dismissing a PR the
 * user reviewed declines its review follow-up (#1857), for the activity
 * posted so far, with the same stamp-based resurfacing when newer activity
 * lands. A review follow-up dismissed with `--head <sha>` also records the
 * PR's head, so a push (new head) brings it back while bot, label and
 * bystander updates do not; see `daily-reviewed-prs.ts`.
 *
 * Dismissing one of the user's own open PRs is still recorded, but it does
 * not clear the PR from Needs Attention: the actionable list is built from
 * the open PR set without a dismiss filter (#657), and `move <pr-url>
 * waiting` is the tool for that. The result carries a `warning` when the URL
 * matches an open PR from the last daily digest so the user and the /oss
 * workflow learn this (#1885).
 */

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import {
  ISSUE_OR_PR_URL_PATTERN,
  PR_URL_PATTERN,
  validateCommitSha,
  validateGitHubUrl,
  validateUrl,
} from './validation.js';

const MODULE = 'dismiss';

export interface DismissOutput {
  dismissed: boolean;
  url: string;
  /**
   * Set when the URL is one of the user's open PRs in the last daily digest:
   * the dismiss was recorded but does not clear the PR from Needs Attention;
   * `move <pr-url> waiting` does (#1885).
   */
  warning?: string;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

/**
 * Warning for dismissing one of the user's open PRs (#1885). Reads the open PR
 * set persisted by the last `daily` run; no GitHub call. Undefined when the URL
 * is not an open PR there (merged, closed, never seen, or no digest yet), or
 * when the PR is shelved: `daily` keeps shelved PRs in `openPRs` but out of
 * Needs Attention, and `move <pr-url> waiting` would unshelve one.
 *
 * URL validation accepts any owner/repo casing while `openPRs` holds GitHub's,
 * so the match is case-insensitive and the suggested `move` command uses the
 * stored URL, which is the one `daily` checks against the shelf.
 */
function openPRDismissWarning(stateManager: ReturnType<typeof getStateManager>, url: string): string | undefined {
  const openPRs = stateManager.getState().lastDigest?.openPRs ?? [];
  const wanted = url.toLowerCase();
  const openPR = openPRs.find((pr) => pr.url.toLowerCase() === wanted);
  if (!openPR || stateManager.isPRShelved(openPR.url)) return undefined;
  return (
    `${openPR.url} is one of your open PRs. dismiss records it but does not clear the PR from Needs Attention; ` +
    `run \`move ${openPR.url} waiting\` for that.`
  );
}

export interface UndismissOutput {
  undismissed: boolean;
  url: string;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

/**
 * Dismiss an issue's reply notifications without posting a comment.
 * The dismissal auto-resurfaces when new responses arrive after the dismiss timestamp.
 *
 * A PR URL is always re-stamped: the merged-PR notes and review follow-up
 * phases compare the stamp with the newest activity, so a second "skip" after
 * newer activity has to move the stamp forward or it would be a no-op. Issue dismissals keep their first
 * stamp (the issue path auto-undismisses on new activity instead).
 *
 * @param options - Dismiss options
 * @param options.url - Full GitHub issue or PR URL
 * @param options.head - For a PR URL: the PR's full head SHA at dismiss time
 *   (the review follow-up entry's `headSha`). Recorded so the follow-up stays
 *   hidden until the head moves or someone comments after the dismiss.
 *   Without it, only the stamp decides, and any update to the PR can resurface it.
 * @returns Whether the issue was newly dismissed (false if already dismissed);
 *   always true for a PR URL. Carries a `warning` when the PR is one of the
 *   user's open PRs from the last daily digest (#1885).
 * @throws {ValidationError} If the URL is not a valid GitHub issue or PR URL,
 *   if `head` is not a full 40-hex SHA, or if `head` is given with an issue URL
 */
export async function runDismiss(options: { url: string; head?: string }): Promise<DismissOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_OR_PR_URL_PATTERN, 'issue or PR');
  const isPR = PR_URL_PATTERN.test(options.url);
  if (!isPR && options.head !== undefined) {
    throw new ValidationError('--head applies to PR URLs only: a dismissed issue has no head commit');
  }

  const stateManager = getStateManager();
  const dismissedAt = new Date().toISOString();
  const dismissOptions = {
    refresh: isPR,
    ...(options.head !== undefined && { headSha: validateCommitSha(options.head) }),
  };
  const added = stateManager.dismissIssue(options.url, dismissedAt, dismissOptions);
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE, () =>
    stateManager.dismissIssue(options.url, dismissedAt, dismissOptions),
  );
  const warning = isPR ? openPRDismissWarning(stateManager, options.url) : undefined;

  return {
    dismissed: added,
    url: options.url,
    ...(warning && { warning }),
    ...(gistSyncWarning && { gistSyncWarning }),
  };
}

/**
 * Restore a dismissed issue to notifications.
 *
 * @param options - Undismiss options
 * @param options.url - Full GitHub issue or PR URL
 * @returns Whether the issue was undismissed (false if not currently dismissed)
 * @throws {ValidationError} If the URL is not a valid GitHub issue or PR URL
 */
export async function runUndismiss(options: { url: string }): Promise<UndismissOutput> {
  validateUrl(options.url);
  validateGitHubUrl(options.url, ISSUE_OR_PR_URL_PATTERN, 'issue or PR');

  const stateManager = getStateManager();
  const removed = stateManager.undismissIssue(options.url);
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE, () => stateManager.undismissIssue(options.url));

  return { undismissed: removed, url: options.url, ...(gistSyncWarning && { gistSyncWarning }) };
}
