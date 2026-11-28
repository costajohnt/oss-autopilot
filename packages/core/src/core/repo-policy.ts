/**
 * Per-repo contribution policy (#1953): AI policy, disclosure line, CLA,
 * commit rules and the gate before a PR, as one record per repo.
 *
 * `derivePolicy` runs the anti-LLM / disclosure scans (anti-llm-policy.ts)
 * and the CONTRIBUTING requirement extraction (contributing.ts) over a repo's
 * docs. `vet` and `vet-list` store the result unreviewed, `policy set` stores the user's
 * record, and `pr-preflight` enforces it (including the commit rules).
 *
 * Policy text comes from other people's repos, so a record holds only
 * enumerated values plus short quoted lines ({@link quote}). The older
 * `config.aiPolicyBlocklist` is read as a ban on top of any stored record:
 * nothing stored can lift it ({@link effectivePolicy}).
 */

import { scanAIDisclosureRequirement, scanForAntiLLMPolicy } from './anti-llm-policy.js';
import { extractRequirements } from './contributing.js';
import { POLICY_QUOTE_MAX, RepoPolicySchema, type AgentState, type RepoPolicy } from './state-schema.js';
import { wrapUntrustedContent } from './untrusted-content.js';

export type { RepoPolicy } from './state-schema.js';
export type AiPolicy = RepoPolicy['aiPolicy'];
export type PrGate = RepoPolicy['prGate'];
export type ClaPolicy = RepoPolicy['cla'];

export const AI_POLICIES: readonly AiPolicy[] = ['allowed', 'disclosure-required', 'banned', 'unknown'];
export const PR_GATES: readonly PrGate[] = ['none', 'claim-first', 'maintainer-label', 'collaborators-only', 'unknown'];
export const CLA_POLICIES: readonly ClaPolicy[] = ['none', 'required', 'unknown'];
export const COMMIT_RULES = ['conventional-commits', 'dco-signoff', 'no-closing-keyword-in-commit'] as const;

/** Source label for a ban that comes from `config.aiPolicyBlocklist`. */
export const BLOCKLIST_SOURCE = 'config aiPolicyBlocklist';

type PolicyState = Pick<AgentState, 'config' | 'repoPolicies'>;

/** One repo document the parsers read: a path and its text. */
export interface PolicyDoc {
  file: string;
  content: string;
}

/** Enumerated fields only: safe to show without a fence. */
export interface RepoPolicySummary {
  aiPolicy: AiPolicy;
  cla: ClaPolicy;
  prGate: PrGate;
  commitRules: string[];
  maxOpenAiPRs?: number;
  reviewedByUser: boolean;
}

/** One line, control characters removed, capped at {@link POLICY_QUOTE_MAX}. */
export function quote(text: string): string {
  const line = text
    .replaceAll(/\p{Cc}/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return line.length > POLICY_QUOTE_MAX ? `${line.slice(0, POLICY_QUOTE_MAX - 1)}…` : line;
}

const BEFORE_PR = /\bbefore\s+(?:opening|submitting|sending|creating|starting|working)\b/i;
const CLAIM_PHRASE = /\b(?:comment\s+on\s+the\s+issue|ask\s+to\s+be\s+assigned|get\s+assigned|be\s+assigned)\b/i;
const PR_NOUN = String.raw`(?:pull\s+requests|prs|contributions)`;

/**
 * `keyword` within a few words after a negation: "do not require a CLA", "no
 * need to be assigned". "without" is not a negation here: "merged without a
 * signed CLA" states the rule.
 */
function negated(keyword: string): RegExp {
  return new RegExp(String.raw`(?:\bno|\bnot|n't)\s+(?:\w+\s+){0,3}?${keyword}`, 'gi');
}

/**
 * `line` with the negated spans blanked, so a positive phrase elsewhere on the
 * line still counts. Known over-match: a negated mention plus a bare
 * re-mention ("no CLA needed, see CLA.md") reads as positive. Accepted: the
 * readings it feeds are unreviewed, and those only warn or need confirmation.
 */
function affirmed(line: string, none: RegExp | undefined): string {
  return none ? line.replaceAll(none, ' ') : line;
}

/** A line states the gate when it matches every pattern of `all` and none of `none`. */
interface LineRule {
  all: readonly RegExp[];
  none?: RegExp;
}

const GATE_RULES: ReadonlyArray<LineRule & { gate: PrGate }> = [
  {
    gate: 'collaborators-only',
    all: [
      new RegExp(
        String.raw`\bonly\s+accepts?\s+${PR_NOUN}\s+from\s+(?:collaborators|maintainers|team\s+members)\b`,
        'i',
      ),
    ],
  },
  {
    gate: 'collaborators-only',
    all: [/(?:\bnot|n't)\s+accept\b/i, new RegExp(String.raw`\b(?:external|outside|unsolicited)\s+${PR_NOUN}\b`, 'i')],
  },
  {
    gate: 'maintainer-label',
    all: [/\bwait\s+(?:for|until)\s+(?:a\s+)?maintainers?\b/i, /\b(?:label|approv|accept|triag)/i, /\bissue/i],
  },
  { gate: 'maintainer-label', all: [/\blabel/i, /\b(?:accepted|approved|ready)\b/i, BEFORE_PR] },
  { gate: 'claim-first', all: [CLAIM_PHRASE, BEFORE_PR], none: negated(String.raw`(?:be\s+|get\s+)?assigned`) },
];

/** Strictest first: the first gate any doc states wins. */
const GATE_ORDER: readonly PrGate[] = ['collaborators-only', 'maintainer-label', 'claim-first'];

const DCO = /\bDCO\b|signed?-off-by|sign[- ]?off/i;
const DCO_NEGATED = negated('(?:DCO|sign(?:ed)?[- ]?off)');

/** Commit rules: a CONTRIBUTING requirement of `category` whose line matches `evidence`, or a line matching `all`. */
const COMMIT_RULE_MATCHERS: ReadonlyArray<Partial<LineRule> & { rule: string; category?: string; evidence?: RegExp }> =
  [
    { rule: 'conventional-commits', category: 'commit_format', evidence: /conventional\s+commits?/i },
    // extractRequirements reports cla_dco once per doc, so a CLA line can hide the DCO one: also scan lines.
    { rule: 'dco-signoff', category: 'cla_dco', evidence: DCO, all: [DCO], none: DCO_NEGATED },
    {
      rule: 'no-closing-keyword-in-commit',
      all: [/\b(?:do\s+not|don't|never)\s+(?:use|include|put|add)\b/i, /\b(?:fixes|closes|resolves)\b/i, /\bcommit/i],
    },
  ];

const CLA_EVIDENCE = /\bCLA\b|contributor\s+license\s+agreement/i;
const CLA_NEGATED = negated(String.raw`(?:CLA\b|contributor\s+license)`);

const COUNT_WORDS: Record<string, number> = { one: 1, 'a single': 1, two: 2, three: 3, four: 4, five: 5 };
const COUNT = String.raw`(\d{1,2}|one|a\s+single|two|three|four|five)`;
const AI_PRS = String.raw`(?:open\s+)?(?:AI|LLM)[-\s](?:assisted|generated|authored|written)\s+(?:PRs?|pull\s+requests?)`;
/**
 * "one AI-assisted PR at a time" (a rate after it does not change it), and "no
 * more than 2 open AI-generated pull requests", "don't open more than one
 * AI-assisted PR" (a rate after these makes them a throughput).
 */
const AI_PR_LIMITS: ReadonlyArray<{ re: RegExp; isRateChecked: boolean }> = [
  {
    re: new RegExp(String.raw`\b${COUNT}\s+${AI_PRS}\s+(?:open\s+)?(?:at\s+(?:a|any\s+one)\s+time|at\s+once)`, 'dgi'),
    isRateChecked: false,
  },
  {
    re: new RegExp(
      String.raw`(?:\bno\s+more\s+than|(?:\bnot|n't|\bnever)\s+(?:\w+\s+)?more\s+than|\bat\s+most|\bup\s+to|\ba\s+maximum\s+of|\blimit(?:ed)?\s+(?:of|to))\s+${COUNT}\s+${AI_PRS}`,
      'dgi',
    ),
    isRateChecked: true,
  },
];
/** "there is no limit on ...", "you don't need to keep to one ...": the rest of the sentence states no limit. */
const AI_PR_LIMIT_NEGATED =
  /(?:\bno|\bnot|n't)\s+(?:\w+\s+){0,2}?(?:limit|restrict|cap\b|maximum|requir|need|have\s+to|must)[^.;!?]*/gi;

/** "... per week", "... a day", "... per contributor per release": a throughput, not an open-PR limit. */
const RATE_AFTER = /^\s*(?:per|a|an|each|every)\s+(?:week|day|month|year|quarter|release|cycle)\b/i;
const PER_PERSON = /^\s*per\s+(?:contributor|person|author|user)\b/i;
/** "maintainers review one ... at a time", "we merge up to 10 ...": what the maintainers do, not a contributor limit. */
const MAINTAINER_VERB = /\b(?:we|maintainers?|reviewers?)\s+(?:\w+\s+)?(?:review|merg|triag)\w*/i;

/** A match that states what maintainers do, or a throughput. */
function isNotALimit(text: string, match: RegExpExecArray, isRateChecked: boolean): boolean {
  const countStart = match.indices?.[1]?.[0] ?? match.index;
  const clause =
    text
      .slice(0, countStart)
      .split(/[.;!?,]/)
      .at(-1) ?? '';
  if (MAINTAINER_VERB.test(clause)) return true;
  const after = text.slice(match.index + match[0].length).replace(PER_PERSON, '');
  return isRateChecked && RATE_AFTER.test(after);
}

/** The first limit the line states, in reading order; null when none. */
function aiPrLimit(line: string): number | null {
  const text = affirmed(line, AI_PR_LIMIT_NEGATED);
  let first: RegExpExecArray | null = null;
  for (const { re, isRateChecked } of AI_PR_LIMITS) {
    for (const match of text.matchAll(re)) {
      const isEarlier = first === null || match.index < first.index;
      if (isEarlier && !isNotALimit(text, match, isRateChecked)) first = match;
    }
  }
  if (!first) return null;
  const count = first[1];
  const n = COUNT_WORDS[count.toLowerCase().replaceAll(/\s+/g, ' ')] ?? Number(count);
  return n > 0 ? n : null;
}

function lineMatching(text: string, rule: LineRule): string | null {
  return text.split(/\r?\n/).find((line) => rule.all.every((p) => p.test(affirmed(line, rule.none)))) ?? null;
}

interface Hit {
  file: string;
  line: string;
}

interface Found {
  ai: (Hit & { policy: AiPolicy }) | null;
  cla: Hit | null;
  commitRules: Array<Hit & { rule: string }>;
  gates: Map<PrGate, Hit>;
  aiPrLimit: (Hit & { max: number }) | null;
}

/** A ban in any doc wins; then a disclosure ask; then an invitation to mention AI reads as `allowed`. */
function scanAi(doc: PolicyDoc, found: Found): void {
  const ban = scanForAntiLLMPolicy(doc.content).matches.at(0);
  if (ban) {
    found.ai = { policy: 'banned', file: doc.file, line: ban.excerpt };
    return;
  }
  const isSettled = found.ai?.policy === 'banned' || found.ai?.policy === 'disclosure-required';
  if (isSettled) return;
  const disclosure = scanAIDisclosureRequirement(doc.content).matches;
  const asked = disclosure.find((m) => m.category !== 'invited');
  if (asked) {
    // The excerpt goes to `source` only: it is a window around the repo's rule, not a line to paste (#2040).
    found.ai = { policy: 'disclosure-required', file: doc.file, line: asked.excerpt };
    return;
  }
  const invited = disclosure.at(0);
  if (invited && !found.ai) found.ai = { policy: 'allowed', file: doc.file, line: invited.excerpt };
}

function scanCommitRules(doc: PolicyDoc, requirements: ReturnType<typeof extractRequirements>, found: Found): void {
  for (const matcher of COMMIT_RULE_MATCHERS) {
    if (found.commitRules.some((r) => r.rule === matcher.rule)) continue;
    const req = requirements.find(
      (r) => r.category === matcher.category && matcher.evidence?.test(affirmed(r.evidence, matcher.none)),
    );
    const line =
      req?.evidence ?? (matcher.all ? lineMatching(doc.content, { all: matcher.all, none: matcher.none }) : null);
    if (line) found.commitRules.push({ rule: matcher.rule, file: doc.file, line });
  }
}

function scanRequirements(doc: PolicyDoc, found: Found): void {
  const requirements = extractRequirements(doc.content);
  const cla = requirements.find(
    (r) => r.category === 'cla_dco' && CLA_EVIDENCE.test(affirmed(r.evidence, CLA_NEGATED)),
  );
  if (cla && !found.cla) found.cla = { file: doc.file, line: cla.evidence };
  scanCommitRules(doc, requirements, found);
  for (const { gate, ...rule } of GATE_RULES) {
    const line = lineMatching(doc.content, rule);
    if (line && !found.gates.has(gate)) found.gates.set(gate, { file: doc.file, line });
  }
  if (!found.aiPrLimit) scanAiPrLimit(doc, found);
}

function scanAiPrLimit(doc: PolicyDoc, found: Found): void {
  const lines = doc.content.split(/\r?\n/);
  for (const line of lines) {
    const max = aiPrLimit(line);
    if (max !== null) {
      found.aiPrLimit = { file: doc.file, line, max };
      return;
    }
  }
}

/**
 * Derive a policy from a repo's docs (CONTRIBUTING, PR template, ...). With no
 * docs every field is `unknown`; a doc that is silent on CLA or a PR gate reads
 * as `none`. Silence on AI stays `unknown`: it is not permission.
 */
export function derivePolicy(docs: readonly PolicyDoc[], now: Date = new Date()): RepoPolicy {
  const found: Found = { ai: null, cla: null, commitRules: [], gates: new Map(), aiPrLimit: null };
  const readable = docs.filter((d) => d.content.trim() !== '');
  for (const doc of readable) {
    scanAi(doc, found);
    scanRequirements(doc, found);
  }
  const gate = GATE_ORDER.find((g) => found.gates.has(g));
  const silent = readable.length > 0 ? 'none' : 'unknown';
  const hits = [found.ai, found.cla, gate ? found.gates.get(gate) : undefined, found.aiPrLimit, ...found.commitRules];
  const source = hits
    .filter((h) => h !== null && h !== undefined)
    .map((h) => ({ file: quote(h.file).slice(0, 100), quotedLine: quote(h.line) }))
    .slice(0, 10);
  return {
    aiPolicy: found.ai?.policy ?? 'unknown',
    cla: found.cla ? 'required' : silent,
    commitRules: found.commitRules.map((r) => r.rule),
    prGate: gate ?? silent,
    ...(found.aiPrLimit && { maxOpenAiPRs: found.aiPrLimit.max }),
    source,
    reviewedByUser: false,
    updatedAt: now.toISOString(),
  };
}

/** Markdown link targets: `[text](target)`. */
const MD_LINK = /\]\(\s*<?([^\s)>]+)/g;
const POLICY_DOC_PATH =
  /(?:^|\/)(?:[^/]*[-_])?(?:contribut|guideline|ai[-_]?(?:policy|usage|use)\b|llm)[^/]*\.(?:md|markdown|rst|txt)$/i;
/** A folder guide: `docs/contributing/README.md`, `docs/ai-policy/index.md`. */
const POLICY_DOC_FOLDER = /(?:^|\/)(?:contribut|guideline|ai[-_]?policy)[^/]*\/(?:readme|index)\.md$/i;
/** Names that match the words but are not guides: the llms.txt site index, a contributors list. */
const NOT_A_GUIDE = /(?:^|\/)(?:llms(?:-full)?\.txt|contributors\.[^/]*)$/i;
/** Where scout already reads CONTRIBUTING from. */
const SCOUT_READ = new Set(['contributing.md', '.github/contributing.md', 'docs/contributing.md']);

/**
 * Up to `max` paths in `repo` that its README links to and that look like a
 * contribution guide or AI policy (relative links, or github.com blob links to
 * the same repo). Links to other sites, other repos or outside the repo root
 * are dropped, as are the CONTRIBUTING paths scout reads anyway.
 */
export function linkedPolicyDocs(readme: string, repo: string, max = 2): string[] {
  const escaped = repo.replaceAll('.', '\\.');
  const sameRepo = new RegExp(String.raw`^https?://github\.com/${escaped}/blob/[^/]+/`, 'i');
  const paths = new Set<string>();
  for (const [, href] of readme.matchAll(MD_LINK)) {
    const path = policyDocPath(href.split(/[?#]/, 1)[0].replace(sameRepo, ''));
    if (path !== null) paths.add(path);
  }
  return [...paths].slice(0, max);
}

/** The repo path a link target names when it looks like a contribution doc, else null. */
function policyDocPath(target: string): string | null {
  // A scheme means another site (or a blob link to another repo); `..` leaves the repo.
  if (/^[a-z][\w+.-]*:/i.test(target) || target.split('/').includes('..')) return null;
  const path = target.replace(/^(?:\.?\/)+/, '');
  const isPolicyDoc = (POLICY_DOC_PATH.test(path) || POLICY_DOC_FOLDER.test(path)) && !NOT_A_GUIDE.test(path);
  return isPolicyDoc && !SCOUT_READ.has(path.toLowerCase()) ? path : null;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

const UNKNOWN_POLICY: Omit<RepoPolicy, 'updatedAt'> = {
  aiPolicy: 'unknown',
  cla: 'unknown',
  commitRules: [],
  prGate: 'unknown',
  source: [],
  reviewedByUser: false,
};

function rawEntry(state: PolicyState, repo: string): Record<string, unknown> | null {
  const raw = state.repoPolicies?.[repo.toLowerCase()];
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
}

/** Fields of the stored entry this release does not know (a newer release added them), to keep across an edit. */
export function unknownFields(state: PolicyState, repo: string): Record<string, unknown> {
  const raw = rawEntry(state, repo) ?? {};
  const known = new Set(Object.keys(RepoPolicySchema.shape));
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key)));
}

/** A stored entry this release cannot parse, e.g. one a newer release wrote with a value added since. */
export function isUnreadable(state: PolicyState, repo: string): boolean {
  const raw = state.repoPolicies?.[repo.toLowerCase()];
  return raw !== undefined && !RepoPolicySchema.safeParse(raw).success;
}

/**
 * `policy` without a `disclosureText` that is an excerpt of the repo's own rule
 * rather than a line the user set (#2040). Releases before that stored the
 * excerpt vet read; `policy set --ai-policy disclosure-required` without
 * `--disclosure-text` then kept it and marked the record reviewed. Either way
 * the text equals the quoted line `vet` put in `source`, which still carries it.
 */
function withoutDerivedDisclosure(policy: RepoPolicy): RepoPolicy {
  const { disclosureText, ...rest } = policy;
  if (disclosureText === undefined) return policy;
  if (!policy.reviewedByUser) return rest;
  const isExcerpt = policy.source.some((s) => s.file !== 'user' && s.quotedLine === disclosureText);
  return isExcerpt ? rest : policy;
}

/**
 * The stored record for `repo`, or null when there is none. An entry that does
 * not parse but says `aiPolicy: 'banned'` still reads as a ban (every other
 * field unknown): a newer release's record must not lift a ban here. A
 * disclosure excerpt an older release stored is dropped on read.
 */
export function storedPolicy(state: PolicyState, repo: string): RepoPolicy | null {
  const raw = rawEntry(state, repo);
  const parsed = RepoPolicySchema.safeParse(raw);
  if (parsed.success) return withoutDerivedDisclosure(parsed.data);
  if (raw?.aiPolicy !== 'banned') return null;
  return { ...UNKNOWN_POLICY, aiPolicy: 'banned', reviewedByUser: raw.reviewedByUser === true, updatedAt: EPOCH };
}

/** True when the raw stored entry says the user set it, even when this release cannot parse the rest. */
export function isUserReviewed(state: PolicyState, repo: string): boolean {
  return rawEntry(state, repo)?.reviewedByUser === true;
}

export function isBlocklisted(state: PolicyState, repo: string): boolean {
  const lower = repo.toLowerCase();
  return (state.config.aiPolicyBlocklist ?? []).some((r) => r.toLowerCase() === lower);
}

/** The record to apply before the blocklist: the user's, a stored ban, a fresh reading, the stored one. */
function basePolicy(stored: RepoPolicy | null, fresh: RepoPolicy | undefined): RepoPolicy | null {
  // A ban vet recorded stays until the user says otherwise; a later reading that misses it does not clear it.
  if (stored?.reviewedByUser || stored?.aiPolicy === 'banned') return stored;
  return fresh ?? stored;
}

/**
 * The policy that applies to `repo`: the user's record, else a stored ban,
 * else a freshly derived one when given, else the stored unreviewed one. A repo
 * in `config.aiPolicyBlocklist` is banned whatever is stored: the blocklist is
 * the older ban list, still synced to clients that predate policy records, and
 * a record never relaxes it. Null when nothing is known.
 */
export function effectivePolicy(state: PolicyState, repo: string, fresh?: RepoPolicy): RepoPolicy | null {
  const base = basePolicy(storedPolicy(state, repo), fresh);
  if (!isBlocklisted(state, repo)) return base;
  const policy = base ?? { ...UNKNOWN_POLICY, updatedAt: EPOCH };
  return {
    ...policy,
    aiPolicy: 'banned',
    source: [{ file: BLOCKLIST_SOURCE, quotedLine: quote(repo) }, ...policy.source].slice(0, 10),
  };
}

const REPO_KEY = /^[^/\s]+\/[^/\s]+$/;

/**
 * Where a ban came from, for the user: nothing for one they confirmed; how to
 * lift it otherwise. A blocklist ban is lifted in config, an unreviewed one
 * with `policy set`.
 */
export function banNote(policy: RepoPolicy, repo: string): string {
  if (policy.source[0]?.file === BLOCKLIST_SOURCE) {
    return ` (from aiPolicyBlocklist: run \`oss-autopilot policy set --repo ${repo} --ai-policy allowed\` to take it off the list if this is wrong)`;
  }
  if (policy.reviewedByUser) return '';
  return ` (read from the repo docs, not reviewed: run \`oss-autopilot policy set --repo ${repo} --ai-policy allowed\` if this is a misreading)`;
}

/** Stored `banned` records (lowercase keys), reviewed or not. */
export function storedBans(state: PolicyState): Array<{ repo: string; reviewedByUser: boolean }> {
  const bans: Array<{ repo: string; reviewedByUser: boolean }> = [];
  if (!state.repoPolicies) return bans;
  const repos = Object.keys(state.repoPolicies);
  for (const repo of repos) {
    // A hand-edited or corrupt key is not a repo; never hand it to search.
    if (!REPO_KEY.test(repo)) continue;
    const policy = storedPolicy(state, repo);
    if (policy?.aiPolicy === 'banned') bans.push({ repo, reviewedByUser: policy.reviewedByUser });
  }
  return bans;
}

/**
 * Repos search leaves out: the blocklist as written, then bans the user
 * confirmed. A ban vet read from the docs but nobody reviewed stays searchable
 * (a heuristic must not shrink discovery on its own); vet still says skip.
 */
export function bannedRepos(state: PolicyState): string[] {
  const blocklist = state.config.aiPolicyBlocklist ?? [];
  const listed = new Set(blocklist.map((r) => r.toLowerCase()));
  const reviewed = storedBans(state)
    .filter((b) => b.reviewedByUser && !listed.has(b.repo))
    .map((b) => b.repo);
  return [...blocklist, ...reviewed];
}

export function summarizePolicy(policy: RepoPolicy): RepoPolicySummary {
  const { aiPolicy, cla, prGate, commitRules, maxOpenAiPRs, reviewedByUser } = policy;
  return { aiPolicy, cla, prGate, commitRules, ...(maxOpenAiPRs !== undefined && { maxOpenAiPRs }), reviewedByUser };
}

/** `{ policy }` with the summary to spread into an output, or `{}` when there is no policy. */
export function policyField(policy: RepoPolicy | null): { policy?: RepoPolicySummary } {
  return policy ? { policy: summarizePolicy(policy) } : {};
}

/**
 * Quoted lines and disclosure text inside `<github-content>` fences, for
 * agent-facing output. `disclosureText` is only ever a line the user set.
 */
export function fencePolicyText(repo: string, policy: RepoPolicy): { disclosureText?: string; sources?: string } {
  const lines = policy.source.map((s) => `${s.file}: ${s.quotedLine}`);
  return {
    ...(policy.disclosureText !== undefined && {
      disclosureText: wrapUntrustedContent(policy.disclosureText, repo, { source: 'repo-policy' }),
    }),
    ...(lines.length > 0 && { sources: wrapUntrustedContent(lines.join('\n'), repo, { source: 'repo-policy' }) }),
  };
}

/** Same rules, ignoring when they were recorded. */
export function isSamePolicy(a: RepoPolicy, b: RepoPolicy): boolean {
  return JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' });
}
