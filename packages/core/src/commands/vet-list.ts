/**
 * Vet-list command (#764)
 * Re-vets all available issues in a curated issue list file via @oss-scout/core.
 */

import * as fs from 'node:fs';
import { adaptScoutLinkedPR, buildCandidateLinkedPR, createAutopilotScout } from './scout-bridge.js';
import {
  type VetListOutput,
  type VetOutput,
  type VetListItemStatus,
  type ParsedIssueItem,
} from '../formatters/json.js';
import { runParseList, pruneIssueList } from './parse-list.js';
import { detectIssueList } from './startup.js';
import { computeSuccessGrade, gradeFromCandidate, reconcileRecommendation } from '../core/issue-grading.js';
import { ValidationError } from '../core/errors.js';
import {
  getStateManager,
  classifyLinkedPR,
  getOctokit,
  requireGitHubToken,
  parseGitHubUrl,
  verifyIssuesBatch,
  type BatchVerificationResult,
  type IssueAvailabilityVerdict,
  type IssueVerification,
} from '../core/index.js';

const UNKNOWN_GRADE = computeSuccessGrade({ avgResponseDays: null, mergeRate: null, daysSinceLastCommit: null });

interface VetListOptions {
  issueListPath?: string;
  concurrency?: number;
  prune?: boolean;
}

/**
 * Scout-side enumerated skip reasons (#1043). If scout emits a `skipReason`
 * field on its vet candidate, we route on that directly rather than doing
 * fragile substring matches against free-text. The strings scout uses today
 * (e.g. "Issue is closed", "Issue is already claimed") would silently stop
 * matching on a rewording — the enum makes the data contract explicit.
 *
 * Scout has not yet landed the enum emitter; this PR lands the reader so the
 * switchover is drop-in when scout ships it. The substring fallback below
 * covers the transition period.
 */
export type ScoutSkipReason =
  'issue_closed' | 'has_linked_pr' | 'claimed' | 'score_too_low' | 'anti_llm_policy' | 'other';

const KNOWN_SKIP_REASONS: ReadonlySet<ScoutSkipReason> = new Set([
  'issue_closed',
  'has_linked_pr',
  'claimed',
  'score_too_low',
  'anti_llm_policy',
  'other',
]);

function mapSkipReasonToStatus(reason: ScoutSkipReason, vetResult: VetOutput): VetListItemStatus | null {
  switch (reason) {
    case 'issue_closed': {
      return 'closed';
    }
    case 'claimed': {
      return 'claimed';
    }
    case 'has_linked_pr': {
      // Open linked PRs that have been idle for 30+ days are revive
      // opportunities (#97 / scout 0.9.0) — surface them with a distinct
      // status rather than auto-dropping as `has_pr`.
      if (vetResult.linkedPR?.state === 'open' && vetResult.linkedPR.isStalled) {
        return 'has_stalled_pr';
      }
      return 'has_pr';
    }
    case 'score_too_low':
    case 'anti_llm_policy':
    case 'other': {
      return null;
    } // fall through to recommendation / default
  }
}

/**
 * Defensively extract a `skipReason` from a scout candidate. Scout's types
 * don't expose it yet, and we want to ignore any value scout emits that
 * isn't one of the expected enum members (forward-compat + poison guard).
 */
export function extractSkipReason(candidate: unknown): ScoutSkipReason | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const raw = (candidate as { skipReason?: unknown }).skipReason;
  if (typeof raw !== 'string') return undefined;
  return KNOWN_SKIP_REASONS.has(raw as ScoutSkipReason) ? (raw as ScoutSkipReason) : undefined;
}

/**
 * Determine the list status from vetting results.
 *
 * Prefers scout's structured `skipReason` enum when present; falls back to
 * substring matching on the free-text `reasonsToSkip` for the transition
 * period before scout emits the enum. See #1043.
 */
export function classifyListStatus(vetResult: VetOutput, skipReason?: ScoutSkipReason): VetListItemStatus {
  if (skipReason) {
    const fromEnum = mapSkipReasonToStatus(skipReason, vetResult);
    if (fromEnum) return fromEnum;
    // skipReason was set but maps to 'other' / low-score / policy — let the
    // recommendation-based branches below decide final status.
  } else {
    const skipReasons = vetResult.reasonsToSkip.map((r) => r.toLowerCase());

    if (skipReasons.some((r) => r.includes('closed'))) return 'closed';
    if (skipReasons.some((r) => r.includes('claimed') || r.includes('assigned'))) return 'claimed';
    if (skipReasons.some((r) => r.includes('existing pr') || r.includes('linked pr') || r.includes('pull request'))) {
      // Same revive-opportunity branch as the enum path above — when scout
      // hasn't yet emitted skipReason but we can see a stalled open PR on
      // the candidate, prefer the dedicated status (#97 / scout 0.9.0).
      if (vetResult.linkedPR?.state === 'open' && vetResult.linkedPR.isStalled) {
        return 'has_stalled_pr';
      }
      return 'has_pr';
    }
  }

  if (vetResult.recommendation === 'approve' || vetResult.recommendation === 'needs_review') {
    return 'still_available';
  }

  // Default: if skipped for other reasons, still mark as available
  // (the vetting result will show why it's not recommended)
  return 'still_available';
}

/**
 * Map a deterministic verify-issue verdict onto the vet-list status taxonomy
 * (#1494). This is the authoritative path: the GraphQL verdict knows the
 * closing-vs-mention distinction (#1353) that scout's substring heuristic
 * cannot, so `at_risk` (mention only) no longer collapses into `claimed`.
 */
export function listStatusFromVerdict(verdict: IssueAvailabilityVerdict): VetListItemStatus {
  switch (verdict) {
    case 'closed': {
      return 'closed';
    }
    case 'own-open-pr': {
      return 'own_open_pr';
    }
    case 'taken': {
      return 'claimed';
    }
    case 'at-risk': {
      return 'at_risk';
    }
    case 'available': {
      return 'still_available';
    }
  }
}

/**
 * Verdicts that conclusively rule an issue out as a new opportunity. For these
 * we skip scout's grade/health vet entirely — there is nothing to grade — and
 * build the result row straight from the verification.
 */
const RULED_OUT_VERDICTS: ReadonlySet<IssueAvailabilityVerdict> = new Set(['closed', 'taken', 'own-open-pr']);

/** The per-row `verification` sub-object: the authoritative facts behind the
 * status, projected from the full {@link IssueVerification}. */
function toVerificationSummary(v: IssueVerification): NonNullable<VetListOutput['results'][number]['verification']> {
  return {
    verdict: v.verdict,
    verdictReason: v.verdictReason,
    state: v.state,
    stateReason: v.stateReason,
    assignees: v.assignees,
    linkedPRs: v.linkedPRs,
  };
}

/** Minimal VetOutput for a ruled-out issue (no scout vet was run). The
 * verification carries the real reason; scout-derived fields are left empty. */
function ruledOutVetOutput(v: IssueVerification): VetOutput {
  return {
    issue: { repo: `${v.owner}/${v.repo}`, number: v.number, title: v.title, url: v.url, labels: [] },
    recommendation: 'skip',
    reasonsToApprove: [],
    reasonsToSkip: [v.verdictReason],
    projectHealth: {},
    vettingResult: {},
    grade: UNKNOWN_GRADE,
  };
}

/**
 * Re-vet all available issues in a curated issue list.
 * Reads the list file, extracts available (non-done) issues,
 * and vets each in parallel with concurrency control.
 *
 * @param options - Vet-list options
 * @returns Consolidated vetting results with list status for each issue
 */
type VetListResult = VetListOutput['results'][number];

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runVetList(options: VetListOptions = {}): Promise<VetListOutput> {
  const concurrency = options.concurrency ?? 5;

  // 1. Find and parse the issue list
  let issueListPath = options.issueListPath;
  if (!issueListPath) {
    const detected = detectIssueList();
    if (!detected) {
      throw new Error('No issue list found. Provide a path with --path or configure issueListPath in settings.');
    }
    issueListPath = detected.path;
  }

  const parsed = await runParseList({ filePath: issueListPath });

  if (parsed.available.length === 0) {
    return {
      results: [],
      summary: {
        total: 0,
        stillAvailable: 0,
        claimed: 0,
        closed: 0,
        hasPR: 0,
        hasStalledPR: 0,
        atRisk: 0,
        ownOpenPr: 0,
        errors: 0,
      },
    };
  }

  const items = parsed.available;

  // 2. Verify FIRST (#1494): one deterministic GraphQL check per entry, in a
  //    bounded batch. The verdict is closing-vs-mention aware, so it carries
  //    the authoritative status — and ruling issues out here means we skip
  //    scout's search-driven vet (a net REDUCTION in /search/issues calls).
  const octokit = getOctokit(requireGitHubToken());
  const verifyTargets: Array<{ index: number; params: { owner: string; repo: string; number: number } }> = [];
  items.forEach((item, i) => {
    const ghUrl = parseGitHubUrl(item.url);
    if (ghUrl && ghUrl.type === 'issues') {
      verifyTargets.push({ index: i, params: { owner: ghUrl.owner, repo: ghUrl.repo, number: ghUrl.number } });
    }
  });
  const batch = await verifyIssuesBatch(
    octokit,
    verifyTargets.map((t) => t.params),
    { concurrency },
  );
  const verificationByIndex = new Map<number, BatchVerificationResult>();
  verifyTargets.forEach((t, k) => verificationByIndex.set(t.index, batch[k]));

  // 3. Vet only the issues still in play; build each row.
  const scout = await createAutopilotScout();

  /** Run scout's grade/health vet for an issue (the search-driven path). */
  async function runScoutVet(item: ParsedIssueItem): Promise<{ vetResult: VetOutput; skipReason?: ScoutSkipReason }> {
    const candidate = await scout.vetIssue(item.url);
    const grade = gradeFromCandidate({
      repo: candidate.issue.repo,
      projectHealth: candidate.projectHealth,
      getRepoScore: (repo) => getStateManager().getRepoScore(repo),
    });
    const userLogin = getStateManager().getState().config.githubUsername;
    const linkedPRClassification = classifyLinkedPR({
      linkedPR: adaptScoutLinkedPR(candidate.vettingResult.linkedPR),
      userLogin,
    });
    const linkedPR = buildCandidateLinkedPR(candidate.vettingResult.linkedPR);
    const vetResult: VetOutput = {
      issue: {
        repo: candidate.issue.repo,
        number: candidate.issue.number,
        title: candidate.issue.title,
        url: candidate.issue.url,
        labels: candidate.issue.labels,
      },
      recommendation: reconcileRecommendation(candidate.recommendation, grade),
      reasonsToApprove: candidate.reasonsToApprove,
      reasonsToSkip: candidate.reasonsToSkip,
      projectHealth: candidate.projectHealth,
      vettingResult: candidate.vettingResult,
      antiLLMPolicy: candidate.antiLLMPolicy,
      linkedPRClassification,
      ...(linkedPR ? { linkedPR } : {}),
      slmTriage: candidate.slmTriage ?? null,
      grade,
    };
    return { vetResult, skipReason: extractSkipReason(candidate) };
  }

  function errorRow(item: ParsedIssueItem, error: unknown): VetListResult {
    const message = toMessage(error);
    return {
      issue: { repo: item.repo, number: item.number, title: item.title, url: item.url, labels: [] },
      recommendation: 'skip',
      reasonsToApprove: [],
      reasonsToSkip: [`Error: ${message}`],
      projectHealth: {},
      vettingResult: {},
      grade: UNKNOWN_GRADE,
      listStatus: 'error',
      errorMessage: message,
    };
  }

  async function processItem(
    item: ParsedIssueItem,
    verification: BatchVerificationResult | undefined,
  ): Promise<VetListResult> {
    // No authoritative verdict for this row: either verify errored, or the URL
    // was never enrolled (parse-list also accepts PR URLs, which `verify-issue`
    // can't classify). Either way `listStatus` falls back to scout's heuristic,
    // so we ALWAYS tag the row with `verifyError` — the explicit signal that the
    // status is not authoritative and must be re-verified before acting.
    if (!verification || verification.verification === undefined) {
      const verifyError = verification?.error;

      // A ValidationError means the issue definitively doesn't exist (deleted,
      // private, or the URL points at a PR). Don't re-grade it via scout — that
      // could mislabel a dead issue as available. Report it as an error row.
      if (verifyError instanceof ValidationError) {
        return { ...errorRow(item, verifyError), verifyError: toMessage(verifyError) };
      }

      // Transient verify failure (rate limit, network, truncated timeline), or a
      // non-issue URL that was never sent to verify. Fall back to scout's
      // heuristic, tagged so the row is re-verified later.
      const verifyErrorTag = {
        verifyError:
          verifyError === undefined
            ? `not verified: ${item.url} is not a verifiable issue URL`
            : toMessage(verifyError),
      };
      try {
        const { vetResult, skipReason } = await runScoutVet(item);
        return { ...vetResult, listStatus: classifyListStatus(vetResult, skipReason), ...verifyErrorTag };
      } catch (error) {
        return { ...errorRow(item, error), ...verifyErrorTag };
      }
    }

    const v = verification.verification;
    const summary = toVerificationSummary(v);
    const listStatus = listStatusFromVerdict(v.verdict);

    // Conclusively ruled out — skip the scout vet entirely.
    if (RULED_OUT_VERDICTS.has(v.verdict)) {
      return { ...ruledOutVetOutput(v), listStatus, verification: summary };
    }

    // available / at-risk: still worth grading. The verdict stays authoritative
    // for listStatus; scout only supplies grade/health/recommendation.
    try {
      const { vetResult } = await runScoutVet(item);
      return { ...vetResult, listStatus, verification: summary };
    } catch (error) {
      // Verify succeeded, so keep its verdict facts even though grading failed.
      return { ...errorRow(item, error), verification: summary };
    }
  }

  const results: VetListResult[] = new Array<VetListResult>(items.length);
  let index = 0;
  async function processNext(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await processItem(items[i], verificationByIndex.get(i));
    }
  }

  // Start `concurrency` workers (bounds the scout-vet fan-out).
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => processNext());
  await Promise.all(workers);

  // 4. Compute summary
  const summary = {
    total: results.length,
    stillAvailable: results.filter((r) => r.listStatus === 'still_available').length,
    claimed: results.filter((r) => r.listStatus === 'claimed').length,
    closed: results.filter((r) => r.listStatus === 'closed').length,
    hasPR: results.filter((r) => r.listStatus === 'has_pr').length,
    hasStalledPR: results.filter((r) => r.listStatus === 'has_stalled_pr').length,
    atRisk: results.filter((r) => r.listStatus === 'at_risk').length,
    ownOpenPr: results.filter((r) => r.listStatus === 'own_open_pr').length,
    errors: results.filter((r) => r.listStatus === 'error').length,
  };

  // 4. Prune the file if requested — remove completed/skipped/low-score items
  let pruneResult: { removedCount: number; error?: string } | undefined;
  if (options.prune && issueListPath) {
    try {
      const content = fs.readFileSync(issueListPath, 'utf8');
      const { pruned, removedCount } = pruneIssueList(content);
      if (pruned !== content) {
        fs.writeFileSync(issueListPath, pruned, 'utf8');
      }
      pruneResult = { removedCount };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Warning: Failed to prune ${issueListPath}: ${msg}`);
      // Surface the failure in the envelope (#1448): without this, a failed
      // prune returned a plain success with pruneResult simply absent — the
      // same shape as "prune not requested".
      pruneResult = { removedCount: 0, error: msg };
    }
  }

  return { results, summary, pruneResult };
}
