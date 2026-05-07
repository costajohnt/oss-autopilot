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
}

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

/** Title byte budget — Conventional Commits style fits comfortably under 72. */
export const TITLE_LENGTH_BUDGET = 72;

/** "Focused changes" thresholds, exported for documentation/testing. */
export const FOCUSED_CHANGES = {
  passFiles: 10,
  passLines: 400,
  warnFiles: 20,
  warnLines: 800,
} as const;

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

function checkIssueReference(meta: PRMetadata): ComplianceCheckResult {
  const weight = WEIGHTS.issueReference;
  if (CLOSING_KEYWORDS.test(meta.body)) {
    return { status: 'pass', weight, detail: 'closing keyword present' };
  }
  if (REFERENCE_KEYWORDS.test(meta.body) || ISSUE_URL.test(meta.body)) {
    return {
      status: 'warn',
      weight,
      detail: 'issue referenced without a closing keyword',
    };
  }
  return { status: 'fail', weight, detail: 'no issue reference' };
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
    issueReference: checkIssueReference(meta),
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
