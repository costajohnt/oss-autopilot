/**
 * PR compliance scoring (#1245).
 *
 * Extracted from `agents/pr-compliance-checker.md`'s in-prompt scoring
 * tables so the weights, thresholds, and per-check rules are
 * deterministic, unit-testable, and tunable without editing markdown.
 * Same architectural shape as success-grade (#858), linked-PR
 * classifier (#910), and anti-AI scan (#911).
 *
 * The function intentionally does not fetch PR data — callers (the MCP
 * tool, the CLI command, the agent) supply pre-fetched metadata so the
 * score is reproducible against fixture data and the same input shape
 * works for both live PRs and historical replay.
 */

export type ComplianceCheckStatus = 'pass' | 'warn' | 'fail';

export interface ComplianceCheckResult {
  status: ComplianceCheckStatus;
  weight: number;
  detail: string;
}

export type ComplianceRating = 'ready' | 'minor' | 'fix_first' | 'significant_work';

/** Emoji surfaced alongside the rating in agent output. */
export type ComplianceEmoji = '🌟' | '✅' | '⚠️' | '❌';

export interface ComplianceScoreResult {
  /** 0–100 weighted score across the six checks. */
  score: number;
  rating: ComplianceRating;
  emoji: ComplianceEmoji;
  checks: {
    issueReference: ComplianceCheckResult;
    description: ComplianceCheckResult;
    focusedChanges: ComplianceCheckResult;
    tests: ComplianceCheckResult;
    title: ComplianceCheckResult;
    branch: ComplianceCheckResult;
  };
}

/** Minimum PR metadata required to compute a compliance score. */
export interface PRMetadata {
  title: string;
  body: string;
  branch: string;
  filesChangedCount: number;
  additions: number;
  deletions: number;
  /**
   * Filenames touched by the PR. Used by the test-detection check to
   * decide whether the PR includes a test file.
   */
  files: string[];
}

/**
 * Verified state of an issue referenced from a PR body. Populated by
 * the compliance-score command (which calls the Issues API per
 * reference) and consumed by `checkIssueReference` to fail loud on
 * broken links (#1246 Improvement B).
 */
export interface LinkedIssueInfo {
  /** Issue number parsed from the PR body. */
  number: number;
  /** Owner/repo where the issue lives — may differ from the PR's repo
   * when a cross-repo reference like `owner/other#42` is used. */
  repo: string;
  /** True when the reference targeted a different repo than the PR. */
  crossRepo: boolean;
  /** Result of the verification API call. `not_found` covers HTTP 404
   * and missing-repo cases alike. */
  state: 'open' | 'closed' | 'not_found';
  /** Whole days since the issue was closed, when state === 'closed'.
   * Used to distinguish "recently closed, may still apply" from "long
   * stale, almost certainly the wrong reference." */
  closedDaysAgo?: number;
}

/**
 * Optional repo context used to fine-tune individual check thresholds
 * (#1245). All fields are optional; absent fields use safe defaults that
 * match the original in-prompt rules.
 */
export interface RepoContext {
  /**
   * Whether the target repo has any visible test infrastructure
   * (`test/`, `tests/`, `__tests__/`, `spec/`, etc.). When `false`, the
   * tests check downgrades from `fail` to `warn` because tests aren't
   * required by the project.
   */
  hasTestInfrastructure?: boolean;
  /**
   * Verified state of every issue/PR reference found in the PR body
   * (#1246 Improvement B). When provided, `checkIssueReference` will
   * fail-loud on broken or stale references rather than passing on the
   * regex match alone. Absent / empty array preserves original
   * regex-only behavior.
   */
  linkedIssues?: LinkedIssueInfo[];
}

/**
 * After how many days a closed-issue reference flips from "warn"
 * (probably still relevant) to "fail" (probably stale). Exported so
 * callers can document the cutoff (#1246).
 */
export const CLOSED_ISSUE_RECENT_DAYS = 30;

const WEIGHTS = {
  issueReference: 25,
  description: 25,
  focusedChanges: 20,
  tests: 15,
  title: 10,
  branch: 5,
} as const;

const STATUS_TO_FRACTION: Record<ComplianceCheckStatus, number> = {
  pass: 1,
  warn: 0.5,
  fail: 0,
};

// Pull canonical rubric thresholds from the single source of truth
// (#1252). Re-exported so existing consumers of compliance-score
// (tests, agent prompts) keep working without touching their imports.
import { TITLE_LENGTH_BUDGET, FOCUSED_CHANGES_THRESHOLDS } from './pr-quality-rubric.js';

/** Title byte budget — Conventional Commits style fits comfortably under 72. */
export { TITLE_LENGTH_BUDGET } from './pr-quality-rubric.js';

/** "Focused changes" thresholds. Source of truth lives in pr-quality-rubric.ts. */
export const FOCUSED_CHANGES = FOCUSED_CHANGES_THRESHOLDS;

/** Score → rating cutoffs. */
export const RATING_CUTOFFS = {
  ready: 90,
  minor: 75,
  fixFirst: 60,
} as const;

/**
 * Detect a closing or referencing keyword in the PR body. GitHub's own
 * auto-close keyword set: close, closes, closed, fix, fixes, fixed,
 * resolve, resolves, resolved.
 */
const CLOSING_KEYWORDS = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+/i;
const REFERENCE_KEYWORDS = /\b(?:relates?\s+to|see|refs?|references?)\s+#\d+/i;
const ISSUE_URL = /https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/i;

/**
 * If verified linked-issue state is available, derive a status from
 * the worst single reference (#1246 Improvement B). Returns `null` when
 * no validation data is supplied — the caller falls back to the
 * regex-only result.
 *
 * Failure modes the precedence ranks (worst first):
 *   1. `not_found` — referenced issue doesn't exist (typo, wrong repo)
 *   2. `closed` more than {@link CLOSED_ISSUE_RECENT_DAYS} days ago
 *   3. `closed` recently — probably still relevant but worth confirming
 *   4. `open` cross-repo — caller should sanity-check the link applies
 *   5. `open` same-repo — canonical pass.
 */
function evaluateLinkedIssues(weight: number, linkedIssues: LinkedIssueInfo[]): ComplianceCheckResult | null {
  if (linkedIssues.length === 0) return null;
  const notFound = linkedIssues.find((li) => li.state === 'not_found');
  if (notFound) {
    const tag = notFound.crossRepo ? `${notFound.repo}#${notFound.number}` : `#${notFound.number}`;
    return {
      status: 'fail',
      weight,
      detail: `linked issue ${tag} does not exist — typo or wrong repo?`,
    };
  }
  const staleClosed = linkedIssues.find(
    (li) => li.state === 'closed' && (li.closedDaysAgo ?? 0) > CLOSED_ISSUE_RECENT_DAYS,
  );
  if (staleClosed) {
    return {
      status: 'fail',
      weight,
      detail:
        `linked issue #${staleClosed.number} has been closed for ` +
        `${staleClosed.closedDaysAgo} days — reference is probably stale`,
    };
  }
  const recentClosed = linkedIssues.find((li) => li.state === 'closed');
  if (recentClosed) {
    return {
      status: 'warn',
      weight,
      detail:
        `linked issue #${recentClosed.number} was closed ` +
        `${recentClosed.closedDaysAgo ?? '?'} days ago — confirm this PR is still relevant`,
    };
  }
  const crossRepo = linkedIssues.find((li) => li.crossRepo);
  if (crossRepo) {
    return {
      status: 'warn',
      weight,
      detail:
        `cross-repo reference ${crossRepo.repo}#${crossRepo.number} — ` +
        `verify the linked issue applies to changes in this repo`,
    };
  }
  return {
    status: 'pass',
    weight,
    detail: `linked issue${linkedIssues.length > 1 ? 's' : ''} verified open`,
  };
}

function checkIssueReference(meta: PRMetadata, repoContext?: RepoContext): ComplianceCheckResult {
  const weight = WEIGHTS.issueReference;
  const hasClosing = CLOSING_KEYWORDS.test(meta.body);
  // The parser's `linkedIssues` already captures cross-repo (`owner/repo#N`)
  // and direct-URL references that the same-repo regex misses. Treat any
  // parsed reference as "a reference exists" so cross-repo links don't
  // collapse to a fail just because they didn't match the bare-ref regex.
  const hasReference =
    hasClosing ||
    REFERENCE_KEYWORDS.test(meta.body) ||
    ISSUE_URL.test(meta.body) ||
    (repoContext?.linkedIssues?.length ?? 0) > 0;
  if (!hasReference) {
    return { status: 'fail', weight, detail: 'no issue reference' };
  }
  // When the caller pre-fetched the linked issues' state, that
  // verification supersedes the regex-only signal — a `Closes #999`
  // pointing at a non-existent issue must not score as pass.
  const verified = repoContext?.linkedIssues ? evaluateLinkedIssues(weight, repoContext.linkedIssues) : null;
  if (verified) return verified;
  if (hasClosing) {
    return { status: 'pass', weight, detail: 'closing keyword present' };
  }
  return {
    status: 'warn',
    weight,
    detail: 'issue referenced without a closing keyword',
  };
}

const SECTION_WHAT = /(?:^|\n)#{1,3}\s*(?:summary|overview|what(?:\s+changed)?)\b/i;
const SECTION_WHY = /(?:^|\n)#{1,3}\s*(?:why|motivation|context|background|rationale)\b/i;
const SECTION_TEST = /(?:^|\n)#{1,3}\s*(?:test\s*plan|how\s+to\s+test|testing|tests?)\b/i;

function checkDescription(meta: PRMetadata): ComplianceCheckResult {
  const weight = WEIGHTS.description;
  const trimmed = meta.body.trim();
  if (trimmed.length === 0) {
    return { status: 'fail', weight, detail: 'description is empty' };
  }
  const what = SECTION_WHAT.test(meta.body);
  const why = SECTION_WHY.test(meta.body);
  const test = SECTION_TEST.test(meta.body);
  const present = [what, why, test].filter(Boolean).length;
  if (present === 3) {
    return { status: 'pass', weight, detail: 'what / why / test sections present' };
  }
  if (present >= 1 || trimmed.length >= 80) {
    return {
      status: 'warn',
      weight,
      detail: `${present} of 3 sections present (what/why/test)`,
    };
  }
  return { status: 'fail', weight, detail: 'minimal description, no recognizable sections' };
}

function checkFocusedChanges(meta: PRMetadata): ComplianceCheckResult {
  const weight = WEIGHTS.focusedChanges;
  const lines = meta.additions + meta.deletions;
  const detail = `${meta.filesChangedCount} files, ${lines} lines`;
  if (meta.filesChangedCount < FOCUSED_CHANGES.passFiles && lines < FOCUSED_CHANGES.passLines) {
    return { status: 'pass', weight, detail };
  }
  if (meta.filesChangedCount > FOCUSED_CHANGES.warnFiles || lines > FOCUSED_CHANGES.warnLines) {
    return { status: 'fail', weight, detail: `${detail} — needs splitting` };
  }
  return { status: 'warn', weight, detail };
}

const TEST_FILE_PATTERN = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[jt]sx?$|\.test_/i;

function checkTests(meta: PRMetadata, repoContext?: RepoContext): ComplianceCheckResult {
  const weight = WEIGHTS.tests;
  const hasTestFile = meta.files.some((f) => TEST_FILE_PATTERN.test(f));
  if (hasTestFile) {
    return { status: 'pass', weight, detail: 'test file(s) touched' };
  }
  if (repoContext?.hasTestInfrastructure === false) {
    return {
      status: 'warn',
      weight,
      detail: 'no tests, but project has no visible test infrastructure',
    };
  }
  return { status: 'fail', weight, detail: 'no test files in a test-requiring project' };
}

const CONVENTIONAL_TITLE = /^(?:feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(?:\([^)]+\))?!?:\s+\S/i;
const VAGUE_EXACT = new Set(['wip', 'test', 'hello', 'tmp', 'temp', 'untitled']);
const ASDF_ONLY = /^[asdfqwer]+$/i;
const NON_DESCRIPTIVE_UPDATE = /^update\s+\S+\s*$/i;

function isVagueTitle(title: string): boolean {
  const trimmed = title.trim();
  if (VAGUE_EXACT.has(trimmed.toLowerCase())) return true;
  if (ASDF_ONLY.test(trimmed)) return true;
  if (NON_DESCRIPTIVE_UPDATE.test(trimmed)) return true;
  return false;
}

function checkTitle(meta: PRMetadata): ComplianceCheckResult {
  const weight = WEIGHTS.title;
  const len = meta.title.length;
  if (isVagueTitle(meta.title)) {
    return { status: 'fail', weight, detail: 'vague or placeholder title' };
  }
  if (len > TITLE_LENGTH_BUDGET) {
    return { status: 'warn', weight, detail: `title is ${len} chars (budget: ${TITLE_LENGTH_BUDGET})` };
  }
  if (CONVENTIONAL_TITLE.test(meta.title)) {
    return { status: 'pass', weight, detail: 'descriptive, conventional, within budget' };
  }
  return { status: 'warn', weight, detail: 'descriptive but not conventional commit format' };
}

const PATCH_NUM_BRANCH = /^patch-\d+$/i;
const ROOT_BRANCH = /^(?:main|master)$/i;

function checkBranch(meta: PRMetadata): ComplianceCheckResult {
  const weight = WEIGHTS.branch;
  if (ROOT_BRANCH.test(meta.branch) || PATCH_NUM_BRANCH.test(meta.branch)) {
    return { status: 'fail', weight, detail: `non-descriptive branch name "${meta.branch}"` };
  }
  // Treat anything containing a separator (`/`, `-`, `_`) as descriptive.
  if (/[/_-]/.test(meta.branch)) {
    return { status: 'pass', weight, detail: meta.branch };
  }
  return { status: 'warn', weight, detail: `branch "${meta.branch}" lacks a clear separator` };
}

function ratingFor(score: number): { rating: ComplianceRating; emoji: ComplianceEmoji } {
  if (score >= RATING_CUTOFFS.ready) return { rating: 'ready', emoji: '🌟' };
  if (score >= RATING_CUTOFFS.minor) return { rating: 'minor', emoji: '✅' };
  if (score >= RATING_CUTOFFS.fixFirst) return { rating: 'fix_first', emoji: '⚠️' };
  return { rating: 'significant_work', emoji: '❌' };
}

/**
 * Compute a compliance score from PR metadata, optionally fine-tuned by
 * repo context (#1245). Pure function — no I/O, no global state.
 */
export function computeComplianceScore(meta: PRMetadata, repoContext?: RepoContext): ComplianceScoreResult {
  const checks = {
    issueReference: checkIssueReference(meta, repoContext),
    description: checkDescription(meta),
    focusedChanges: checkFocusedChanges(meta),
    tests: checkTests(meta, repoContext),
    title: checkTitle(meta),
    branch: checkBranch(meta),
  };
  const weighted = Object.values(checks).reduce(
    (acc, check) => acc + STATUS_TO_FRACTION[check.status] * check.weight,
    0,
  );
  const score = Math.round(weighted);
  const { rating, emoji } = ratingFor(score);
  return { score, rating, emoji, checks };
}
