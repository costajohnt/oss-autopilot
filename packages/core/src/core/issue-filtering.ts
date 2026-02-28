/**
 * Issue Filtering — pure functions for filtering and spam detection on search results.
 *
 * Extracted from issue-discovery.ts (#356) to isolate filtering logic:
 * label farming detection, doc-only filtering, per-repo caps, templated title detection.
 */

/** Minimal shape of a GitHub search result item (from octokit.search.issuesAndPullRequests) */
export interface GitHubSearchItem {
  html_url: string;
  repository_url: string;
  updated_at: string;
  title?: string;
  labels?: Array<{ name?: string } | string>;
  [key: string]: unknown;
}

/** Labels that indicate documentation-only issues (#105). */
export const DOC_ONLY_LABELS = new Set(['documentation', 'docs', 'typo', 'spelling']);

/**
 * Check if an issue's labels are ALL documentation-related (#105).
 * Issues with mixed labels (e.g., "good first issue" + "documentation") pass through.
 * Issues with no labels are not considered doc-only.
 */
export function isDocOnlyIssue(item: GitHubSearchItem): boolean {
  if (!item.labels || !Array.isArray(item.labels) || item.labels.length === 0) return false;
  const labelNames = item.labels.map((l) => (typeof l === 'string' ? l : l.name || '').toLowerCase());
  // Filter out empty label names before checking
  const nonEmptyLabels = labelNames.filter((n) => n.length > 0);
  if (nonEmptyLabels.length === 0) return false;
  return nonEmptyLabels.every((n) => DOC_ONLY_LABELS.has(n));
}

/** Known beginner-type label names used to detect label-farming repos (#97). */
export const BEGINNER_LABELS = new Set([
  'good first issue',
  'hacktoberfest',
  'easy',
  'up-for-grabs',
  'first-timers-only',
  'beginner-friendly',
  'beginner',
  'starter',
  'newbie',
  'low-hanging-fruit',
  'community',
]);

/** Check if a single issue has an excessive number of beginner labels (>= 5). */
export function isLabelFarming(item: GitHubSearchItem): boolean {
  if (!item.labels || !Array.isArray(item.labels)) return false;
  const labelNames = item.labels.map((l) => (typeof l === 'string' ? l : l.name || '').toLowerCase());
  const beginnerCount = labelNames.filter((n) => BEGINNER_LABELS.has(n)).length;
  return beginnerCount >= 5;
}

/** Detect mass-created issue titles like "Add Trivia Question 61" or "Create Entry #5". */
export function hasTemplatedTitle(title: string): boolean {
  if (!title) return false;
  // Matches "<anything> <category-noun> <number>" where category nouns are typical
  // of mass-created templated issues. This avoids false positives on legitimate titles
  // like "Add support for Python 3" or "Implement RFC 7231" which lack category nouns.
  return /^.+\s+(question|fact|point|item|task|entry|post|challenge|exercise|example|problem|tip|recipe|snippet)\s+#?\d+$/i.test(
    title,
  );
}

/**
 * Batch-analyze search items to detect label-farming repositories (#97).
 * Returns a Set of repo full names (owner/repo) that appear to be spam.
 *
 * A repo is flagged if:
 * - ANY single issue has >= 5 beginner labels (strong individual signal), OR
 * - It has >= 3 issues with templated titles (batch signal)
 */
export function detectLabelFarmingRepos(items: GitHubSearchItem[]): Set<string> {
  const spamRepos = new Set<string>();
  const repoSpamCounts = new Map<string, number>();

  for (const item of items) {
    const repoFullName = item.repository_url.split('/').slice(-2).join('/');

    // Strong signal: single issue with 5+ beginner labels
    if (isLabelFarming(item)) {
      spamRepos.add(repoFullName);
      continue;
    }

    // Weaker signal: templated title
    if (item.title && hasTemplatedTitle(item.title)) {
      repoSpamCounts.set(repoFullName, (repoSpamCounts.get(repoFullName) || 0) + 1);
    }
  }

  // Flag repos with 3+ templated-title issues
  for (const [repo, count] of repoSpamCounts) {
    if (count >= 3) {
      spamRepos.add(repo);
    }
  }

  return spamRepos;
}

/**
 * Apply per-repo cap to candidates (#105).
 * Keeps at most `maxPerRepo` issues from any single repo.
 * Maintains the existing sort order — first N from each repo are kept,
 * excess issues from over-represented repos are dropped.
 */
export function applyPerRepoCap<T extends { issue: { repo: string } }>(candidates: T[], maxPerRepo: number): T[] {
  const repoCounts = new Map<string, number>();
  const kept: T[] = [];

  for (const c of candidates) {
    const count = repoCounts.get(c.issue.repo) || 0;
    if (count < maxPerRepo) {
      kept.push(c);
      repoCounts.set(c.issue.repo, count + 1);
    }
  }

  return kept;
}
