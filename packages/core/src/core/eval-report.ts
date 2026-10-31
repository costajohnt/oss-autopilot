/**
 * Eval report (#1825): is oss-autopilot picking better over time?
 *
 * Pure computation over the outcome ledger. Every merged, closed-unmerged and
 * dormant PR is one outcome; the `pick` snapshot recorded at vet time (#1824)
 * is the prediction it is compared against. Merge rate counts dormant PRs in
 * the denominator, so stalled work cannot flatter the number.
 */

import type { AgentState, PickSnapshot, StoredClosedPR } from './types.js';

type Outcome = 'merged' | 'closed' | 'dormant';

interface OutcomeRow {
  url: string;
  repo: string;
  outcome: Outcome;
  /** YYYY-MM of the merge/close; dormant PRs have none. */
  month?: string;
  grade?: number;
  gradeSource?: 'vet' | 'list';
  stars?: number;
  hoursToMerge?: number;
  hoursToFirstResponse?: number;
  /** Open enum: a newer release may record reasons this one does not know (#1831). */
  closeReason?: StoredClosedPR['closeReason'];
  /** Open enum, like closeReason (#1831). */
  selfCloseReason?: StoredClosedPR['selfCloseReason'];
  changesRequested?: boolean;
  ciFailing?: boolean;
  /** No merged PR in the same repo when this PR was opened (pick-time value when recorded, else derived from the ledger). */
  firstInRepo: boolean;
  pick?: PickSnapshot;
}

export interface EvalBucket {
  key: string;
  n: number;
  merged: number;
  closed: number;
  dormant: number;
  /** merged / n, rounded to 2 places; null when n is 0. */
  mergeRate: number | null;
  medianHoursToMerge: number | null;
  medianHoursToFirstResponse: number | null;
}

export interface EvalReport {
  generatedAt: string;
  totals: EvalBucket;
  headlines: {
    /** Merge rate on repos with at least 1k stars. */
    mergeRate1kStars: EvalBucket;
    /**
     * Vet-graded picks only (list scores are pre-filtered to 6+, so they can
     * never land on the low side). `gap` is the grade >= 7 merge rate minus
     * the grade <= 5 one, null until both sides have MIN_FLAG_N outcomes.
     */
    calibration: { gap: number | null; highN: number; lowN: number };
    /** Closures as ai-policy or rejected, per close month. */
    approachClosuresByMonth: Record<string, number>;
  };
  byGrade: EvalBucket[];
  byStars: EvalBucket[];
  byMonth: EvalBucket[];
  /** All outcomes: first PR in the repo vs returning. */
  byFirstInRepo: EvalBucket[];
  /** Picks only; picks recorded before the trait existed land in `not recorded`. */
  byIssueAuthorRole: EvalBucket[];
  /** Picks only: open PRs by others on the issue at pick time. */
  byCompetingPRs: EvalBucket[];
  /** Picks with labels only; one pick can count in several label groups. */
  byLabel: EvalBucket[];
  closeReasons: Record<string, number>;
  quality: { withReviewState: number; changesRequestedShare: number | null; ciFailingShare: number | null };
  /** Vet-graded prediction/outcome pairs (merged + closed). */
  calibrationPairs: number;
  /** Buckets where prediction and outcome disagree. */
  flags: string[];
}

const HOUR = 3_600_000;
/** Minimum bucket size before a flag is raised. */
const MIN_FLAG_N = 5;

function repoOf(url: string): string {
  return url.split('/').slice(3, 5).join('/');
}

function hoursBetween(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms / HOUR : undefined;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m * 10) / 10;
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 100) / 100;
}

function bucket(key: string, rows: OutcomeRow[]): EvalBucket {
  const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
  const merged = count('merged');
  return {
    key,
    n: rows.length,
    merged,
    closed: count('closed'),
    dormant: count('dormant'),
    mergeRate: rate(merged, rows.length),
    medianHoursToMerge: median(rows.flatMap((r) => (r.hoursToMerge === undefined ? [] : [r.hoursToMerge]))),
    medianHoursToFirstResponse: median(
      rows.flatMap((r) => (r.hoursToFirstResponse === undefined ? [] : [r.hoursToFirstResponse])),
    ),
  };
}

/** Group rows by a key function, keeping `order` first and dropping empty groups. */
function groupBy(rows: OutcomeRow[], keyOf: (r: OutcomeRow) => string, order: string[] = []): EvalBucket[] {
  const groups = new Map<string, OutcomeRow[]>(order.map((k) => [k, []]));
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups].filter(([, g]) => g.length > 0).map(([k, g]) => bucket(k, g));
}

function gradeRange(grade: number | undefined): string {
  if (grade === undefined) return 'none';
  if (grade <= 4) return '1-4';
  if (grade <= 6) return '5-6';
  if (grade <= 8) return '7-8';
  return '9-10';
}

function starRange(stars: number | undefined): string {
  if (stars === undefined) return 'unknown';
  if (stars < 100) return '<100';
  if (stars < 1000) return '100-1k';
  if (stars < 10_000) return '1k-10k';
  return '10k+';
}

/** Normalized label groups for the label cut; a label matches by substring. */
const LABEL_GROUPS: Array<[string, RegExp]> = [
  ['good first issue', /\bgood[ -]?first\b|\bbeginner\b|\beasy\b/],
  ['help wanted', /\bhelp[ -]?wanted\b/],
  ['bug', /\bbugs?\b/],
  ['enhancement', /\benhancements?\b|\bfeatures?\b/],
  ['documentation', /\bdoc(s|umentation)?\b/],
];

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const OUTSIDER_ASSOCIATIONS = new Set(['NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN']);

/** Issue-author bucket from the raw association recorded at pick time. */
function authorRole(pick: PickSnapshot): string {
  if (pick.issueAuthorIsBot) return 'bot';
  const a = pick.issueAuthorAssociation;
  if (a === undefined) return NOT_RECORDED;
  if (MAINTAINER_ASSOCIATIONS.has(a)) return 'maintainer';
  if (a === 'CONTRIBUTOR') return 'contributor';
  return OUTSIDER_ASSOCIATIONS.has(a) ? 'outsider' : 'unknown';
}
const NO_LABEL_GROUP = 'none of these';
const NOT_RECORDED = 'not recorded';

function labelGroups(labels: string[]): string[] {
  const lower = labels.map((l) => l.toLowerCase());
  const groups = LABEL_GROUPS.filter(([, re]) => lower.some((l) => re.test(l))).map(([g]) => g);
  return groups.length > 0 ? groups : [NO_LABEL_GROUP];
}

function collectRows(state: Readonly<AgentState>): OutcomeRow[] {
  const starsOf = (repo: string) => state.repoScores[repo]?.stargazersCount;
  // Merge times per repo, so a PR is first-in-repo when no merge in the same
  // repo precedes its opening. Works for entries recorded before picks existed.
  // ponytail: only sees merges the ledger holds; older merges count as none.
  const mergeTimes = new Map<string, number[]>();
  const mergedLedger = state.mergedPRs ?? [];
  for (const e of mergedLedger) {
    const repo = repoOf(e.url).toLowerCase();
    mergeTimes.set(repo, [...(mergeTimes.get(repo) ?? []), Date.parse(e.mergedAt)]);
  }
  const isFirstAt = (repo: string, at: number) => (mergeTimes.get(repo.toLowerCase()) ?? []).every((t) => t >= at);
  const common = (
    e: (typeof state.mergedPRs & object)[number] | (typeof state.closedPRs & object)[number],
    at: string,
  ) => {
    const repo = repoOf(e.url);
    return {
      url: e.url,
      repo,
      firstInRepo: e.pick?.firstInRepo ?? isFirstAt(repo, Date.parse(e.openedAt ?? at)),
      pick: e.pick,
      grade: e.pick?.grade,
      gradeSource: e.pick ? (e.pick.source === 'list' ? ('list' as const) : ('vet' as const)) : undefined,
      stars: e.pick?.stargazersCount ?? starsOf(repo),
      hoursToFirstResponse: hoursBetween(e.openedAt, e.firstMaintainerResponseAt),
      changesRequested: e.lastReviewDecision ? e.lastReviewDecision === 'changes_requested' : undefined,
      ciFailing: e.lastCiStatus ? e.lastCiStatus === 'failing' : undefined,
    };
  };
  const merged: OutcomeRow[] = (state.mergedPRs ?? []).map((e) => ({
    ...common(e, e.mergedAt),
    outcome: 'merged',
    month: e.mergedAt.slice(0, 7),
    hoursToMerge: hoursBetween(e.openedAt, e.mergedAt),
  }));
  const closed: OutcomeRow[] = (state.closedPRs ?? []).map((e) => ({
    ...common(e, e.closedAt),
    outcome: 'closed',
    month: e.closedAt.slice(0, 7),
    closeReason: e.closeReason,
    selfCloseReason: e.selfCloseReason,
  }));
  const dormant: OutcomeRow[] = (state.lastDigest?.openPRs ?? [])
    .filter((pr) => pr.stalenessTier === 'dormant')
    .map((pr) => ({
      url: pr.url,
      repo: pr.repo,
      outcome: 'dormant',
      stars: starsOf(pr.repo),
      firstInRepo: isFirstAt(pr.repo, Date.parse(pr.createdAt)),
    }));
  return [...merged, ...closed, ...dormant];
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
const hrs = (v: number | null) => (v === null ? 'n/a' : `${v}h`);

export function computeEvalReport(state: Readonly<AgentState>, now: Date = new Date()): EvalReport {
  const rows = collectRows(state);
  const graded = rows.filter((r) => r.gradeSource === 'vet' && r.outcome !== 'dormant');
  const high = graded.filter((r) => r.grade! >= 7);
  const low = graded.filter((r) => r.grade! <= 5);
  const mergedShare = (g: OutcomeRow[]) => g.filter((r) => r.outcome === 'merged').length / g.length;
  const separable = high.length >= MIN_FLAG_N && low.length >= MIN_FLAG_N;
  const gap = separable ? Math.round((mergedShare(high) - mergedShare(low)) * 100) / 100 : null;

  const closedRows = rows.filter((r) => r.outcome === 'closed');
  const closeReasons: Record<string, number> = {};
  const approachClosuresByMonth: Record<string, number> = {};
  for (const r of closedRows) {
    // Self-closed splits by what preceded it, e.g. "self-closed: no-response".
    const reason = r.selfCloseReason ? `self-closed: ${r.selfCloseReason}` : (r.closeReason ?? 'unclassified');
    closeReasons[reason] = (closeReasons[reason] ?? 0) + 1;
    if ((r.closeReason === 'ai-policy' || r.closeReason === 'rejected') && r.month) {
      approachClosuresByMonth[r.month] = (approachClosuresByMonth[r.month] ?? 0) + 1;
    }
  }

  const picked = rows.filter((r) => r.pick);

  const reviewed = rows.filter((r) => r.changesRequested !== undefined);
  const ciKnown = rows.filter((r) => r.ciFailing !== undefined);

  const byGrade = groupBy(rows, (r) => (r.gradeSource ? `${r.gradeSource} ${gradeRange(r.grade)}` : 'no prediction'), [
    'vet 9-10',
    'vet 7-8',
    'vet 5-6',
    'vet 1-4',
    'list 9-10',
    'list 7-8',
    'list 5-6',
    'list 1-4',
    'no prediction',
  ]);
  const flags = byGrade
    .filter((b) => /(?:9-10|7-8)$/.test(b.key) && b.n >= MIN_FLAG_N && (b.mergeRate ?? 1) < 0.6)
    .map((b) => `${b.key}: high-grade picks merge at ${Math.round(b.mergeRate! * 100)}% (n=${b.n})`);
  if (gap !== null && gap <= 0) {
    flags.push(
      `vet grades do not separate outcomes: grade>=7 merges at ${pct(rate(high.filter((r) => r.outcome === 'merged').length, high.length))} (n=${high.length}), grade<=5 at ${pct(rate(low.filter((r) => r.outcome === 'merged').length, low.length))} (n=${low.length})`,
    );
  }

  return {
    generatedAt: now.toISOString(),
    totals: bucket('all', rows),
    headlines: {
      mergeRate1kStars: bucket(
        '>=1k stars',
        rows.filter((r) => (r.stars ?? 0) >= 1000),
      ),
      calibration: { gap, highN: high.length, lowN: low.length },
      approachClosuresByMonth,
    },
    byGrade,
    byStars: groupBy(rows, (r) => starRange(r.stars), ['10k+', '1k-10k', '100-1k', '<100', 'unknown']),
    byMonth: groupBy(
      rows.filter((r) => r.month),
      (r) => r.month!,
    ).sort((a, b) => b.key.localeCompare(a.key)),
    byFirstInRepo: groupBy(rows, (r) => (r.firstInRepo ? 'first in repo' : 'returning'), [
      'first in repo',
      'returning',
    ]),
    byIssueAuthorRole: groupBy(picked, (r) => authorRole(r.pick!), [
      'maintainer',
      'contributor',
      'outsider',
      'bot',
      'unknown',
      NOT_RECORDED,
    ]),
    byCompetingPRs: groupBy(
      picked,
      (r) => {
        const n = r.pick!.competingPRs;
        if (n === undefined) return NOT_RECORDED;
        return n === 0 ? '0' : '1+';
      },
      ['0', '1+', NOT_RECORDED],
    ),
    byLabel: [...LABEL_GROUPS.map(([g]) => g), NO_LABEL_GROUP]
      .map((g) =>
        bucket(
          g,
          picked.filter((r) => r.pick!.labels && labelGroups(r.pick!.labels).includes(g)),
        ),
      )
      .filter((b) => b.n > 0),
    closeReasons,
    quality: {
      withReviewState: reviewed.length,
      changesRequestedShare: rate(reviewed.filter((r) => r.changesRequested).length, reviewed.length),
      ciFailingShare: rate(ciKnown.filter((r) => r.ciFailing).length, ciKnown.length),
    },
    calibrationPairs: graded.length,
    flags,
  };
}

function table(title: string, buckets: EvalBucket[]): string[] {
  return [
    `## ${title}`,
    '',
    '| Bucket | n | Merged | Closed | Dormant | Merge rate | Median to merge | Median to first response |',
    '|---|---|---|---|---|---|---|---|',
    ...buckets.map(
      (b) =>
        `| ${b.key} | ${b.n} | ${b.merged} | ${b.closed} | ${b.dormant} | ${pct(b.mergeRate)} | ${hrs(b.medianHoursToMerge)} | ${hrs(b.medianHoursToFirstResponse)} |`,
    ),
    '',
  ];
}

export function formatEvalMarkdown(r: EvalReport): string {
  const h = r.headlines;
  const recentMonths = Object.keys(h.approachClosuresByMonth).sort().reverse().slice(0, 6);
  return [
    `# oss-autopilot eval (${r.generatedAt.slice(0, 10)})`,
    '',
    '## Headlines',
    '',
    `- Merge rate on repos with 1k+ stars: **${pct(h.mergeRate1kStars.mergeRate)}** (n=${h.mergeRate1kStars.n})`,
    `- Calibration gap, vet grades (grade>=7 minus grade<=5 merge rate): **${h.calibration.gap ?? 'n/a'}** (n=${h.calibration.highN} vs ${h.calibration.lowN}; needs ${MIN_FLAG_N} each)`,
    `- Approach or AI-policy closures by month: ${recentMonths.length ? recentMonths.map((m) => `${m}: ${h.approachClosuresByMonth[m]}`).join(', ') : 'none'}`,
    `- Overall: ${r.totals.n} outcomes, merge rate ${pct(r.totals.mergeRate)} (dormant counted as not merged)`,
    '',
    ...(r.flags.length ? ['## Flags', '', ...r.flags.map((f) => `- ${f}`), ''] : []),
    ...table('By grade at pick time', r.byGrade),
    ...table('By repo stars', r.byStars),
    ...table('By month', r.byMonth.slice(0, 12)),
    ...table('First PR in repo vs returning', r.byFirstInRepo),
    ...table('By issue author (picks)', r.byIssueAuthorRole),
    ...table('By competing PRs at pick time (picks)', r.byCompetingPRs),
    ...table('By issue label (picks; one pick can match several)', r.byLabel),
    '## Close reasons',
    '',
    ...Object.entries(r.closeReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Review quality',
    '',
    `- PRs with a recorded review state: ${r.quality.withReviewState}`,
    `- Changes requested before the outcome: ${pct(r.quality.changesRequestedShare)}`,
    `- CI failing at last sight: ${pct(r.quality.ciFailingShare)}`,
    '',
  ].join('\n');
}
