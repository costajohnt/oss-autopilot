/**
 * Anti-LLM policy scan (#108, #911, #979).
 *
 * Scan concatenated repo docs (CONTRIBUTING.md, CODE_OF_CONDUCT.md,
 * README) for language that indicates the project does not accept
 * AI/LLM-generated contributions. Previously described as a keyword
 * table in prose in agents/issue-scout.md.
 *
 * The long-term home for this logic is `@oss-scout/core`, where the
 * relevant files are already fetched during vetting. Keeping it here
 * for now lets the agent invoke it directly and gives scout a
 * reference implementation + test fixtures to adopt. See #979.
 *
 * Precision matters more than recall. False positives (flagging a
 * project that actually welcomes AI help) silently shrink the user's
 * contribution surface without recourse. We only match on phrases
 * that combine a rejection keyword (no / reject / will be closed /
 * don't accept) with an AI/LLM noun.
 *
 * **User-facing reference:** `docs/anti-llm-policy.md` — explains the
 * three categories, example phrases per category, and the false-positive-
 * resistance design (why "AI division will be closed at end of Q4"
 * does NOT match).
 */

export type AntiLLMCategory = 'explicit_ban' | 'tool_ban' | 'reject_framing';

export interface AntiLLMMatch {
  category: AntiLLMCategory;
  /** The exact substring from the source text that triggered the match. */
  phrase: string;
  /** ~80 character window around the match, for surfacing to the user. */
  excerpt: string;
}

export interface AntiLLMScanResult {
  matched: boolean;
  matches: AntiLLMMatch[];
}

interface Pattern {
  category: AntiLLMCategory;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  // Explicit "no X" bans against AI/LLM nouns.
  { category: 'explicit_ban', regex: /\bno\s+(ai|llm)[-\s](generated|authored|written|assisted|contributions?)/i },
  { category: 'explicit_ban', regex: /\b(ban|banned|banning)\s+(ai|llm)\b/i },

  // Named-tool bans. Optionally match a "-generated/-authored/-…"
  // continuation (clear ban wording), and use a negative lookahead to
  // reject unrelated hyphen-words like "no copilot-style autocomplete"
  // (which describes a feature, not a contribution policy).
  {
    category: 'tool_ban',
    regex: /\bno\s+(copilot|chatgpt|claude|cursor)(-(generated|authored|assisted|written))?(?![a-z-])/i,
  },
  { category: 'tool_ban', regex: /\bno\s+ai\s+coding\s+tools?\b/i },

  // Rejection framing. To avoid false positives like "AI PRs are closed
  // to new comments" (closed means something else) or "AI suggestions
  // from your IDE" (not a contribution), we require both an AI/LLM
  // qualifier AND a contribution noun AND a rejection verb phrase. The
  // two patterns cover "AI-generated code will be closed" (with
  // participle) and "AI contributions will be closed" (without).
  {
    category: 'reject_framing',
    regex:
      /\b(ai|llm)[-\s](generated|assisted|authored|written)\s+(code|prs?|contributions?)\s+(will\s+be\s+(closed|rejected)|are\s+rejected)/i,
  },
  {
    category: 'reject_framing',
    regex: /\b(ai|llm)\s+(code|prs?|contributions?)\s+(will\s+be\s+(closed|rejected)|are\s+rejected)/i,
  },
  // "do/does not accept AI-{noun}" / "reject AI contributions" — both
  // require a contribution noun to avoid matching "accept AI suggestions
  // from your IDE" or similar incidental mentions.
  {
    category: 'reject_framing',
    regex:
      /\b(do|does)(\s+not|n't)\s+accept\s+(ai|llm)[-\s](generated|assisted|authored|written|contributions?|code|prs?)\b/i,
  },
  { category: 'reject_framing', regex: /\breject\s+(ai|llm)\s+contributions?\b/i },
];

const EXCERPT_RADIUS = 40;

function makeExcerpt(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(text.length, matchIndex + matchLength + EXCERPT_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

/**
 * Normalize exotic whitespace and hyphens so patterns written with plain
 * ASCII still match real-world markdown. Covers non-breaking space,
 * non-breaking hyphen, en dash, em dash, and figure dash — all of which
 * show up in CONTRIBUTING files authored in rich-text editors.
 */
function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u00A0]/g, ' ')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-');
}

export function scanForAntiLLMPolicy(text: string): AntiLLMScanResult {
  if (typeof text !== 'string') {
    throw new TypeError(`scanForAntiLLMPolicy: expected string, received ${typeof text}`);
  }
  if (text === '') return { matched: false, matches: [] };

  const normalized = normalizeText(text);
  const seenLabels = new Set<string>();
  const matches: AntiLLMMatch[] = [];

  for (const pattern of PATTERNS) {
    const hit = normalized.match(pattern.regex);
    if (!hit || hit.index === undefined) continue;
    const phrase = hit[0];
    const key = `${pattern.category}:${phrase.toLowerCase()}`;
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);
    matches.push({
      category: pattern.category,
      phrase,
      excerpt: makeExcerpt(normalized, hit.index, phrase.length),
    });
  }

  return { matched: matches.length > 0, matches };
}
