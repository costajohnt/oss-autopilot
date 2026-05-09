/**
 * AI/LLM policy scans (#108, #911, #979, #1269).
 *
 * Two complementary scanners over the same input (concatenated repo docs
 * — CONTRIBUTING.md, CODE_OF_CONDUCT.md, README, etc.):
 *
 * 1. {@link scanForAntiLLMPolicy} — detects language indicating the
 *    project does NOT accept AI/LLM-generated contributions. Used by
 *    issue-scout / repo-evaluator to filter out repos where landing a
 *    PR is impossible.
 *
 * 2. {@link scanAIDisclosureRequirement} — detects the opposite:
 *    language requiring or inviting AI disclosure ("must disclose AI
 *    use", "credit AI tools"). Used by pr-compliance-checker to decide
 *    whether AI attribution should be flagged as a violation, encouraged,
 *    or required (#1269 Improvement C).
 *
 * The long-term home for this logic is `@oss-scout/core`, where the
 * relevant files are already fetched during vetting. Keeping it here
 * for now lets the agent invoke it directly and gives scout a
 * reference implementation + test fixtures to adopt. See #979.
 *
 * Precision matters more than recall in both directions. A false
 * positive on the anti-LLM side silently shrinks the user's
 * contribution surface; a false positive on the disclosure side tells
 * the user to add attribution that the maintainer didn't actually ask
 * for. Patterns require an explicit verb-phrase + AI/LLM-noun pairing.
 *
 * **User-facing reference:** `docs/anti-llm-policy.md` — explains the
 * three anti-LLM categories, example phrases per category, and the
 * false-positive-resistance design (why "AI division will be closed at
 * end of Q4" does NOT match).
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
  { category: 'explicit_ban', regex: /\bno\s+(ai|llm)[\s-](generated|authored|written|assisted|contributions?)/i },
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
      /\b(ai|llm)[\s-](generated|assisted|authored|written)\s+(code|prs?|contributions?)\s+(will\s+be\s+(closed|rejected)|are\s+rejected)/i,
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
      /\b(do|does)(\s+not|n't)\s+accept\s+(ai|llm)[\s-](generated|assisted|authored|written|contributions?|code|prs?)\b/i,
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
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2010-\u2015]/g, '-');
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

// ── AI Disclosure Requirement Scan (#1269 Improvement C) ─────────────────
//
// Sibling to scanForAntiLLMPolicy, scanning the same input for the OPPOSITE
// signal: language that requires or invites disclosure of AI assistance.
// Three categories (most → least binding):
//
//   - 'mandatory'  — "must disclose", "required to indicate", etc.
//   - 'recommended' — "credit AI tools", "we appreciate disclosure"
//   - 'invited'    — "feel free to mention if you used AI"
//
// Consumers (today: pr-compliance-checker via prompt) combine this with
// scanForAntiLLMPolicy to choose between three regimes:
//
//   - Anti-LLM matched → flag AI attribution as fail
//   - Disclosure required → flag MISSING attribution as fail (when caller
//     knows AI was used) / no-op otherwise
//   - Neither matched → keep current default (flag attribution as warn)

export type AIDisclosureCategory = 'mandatory' | 'recommended' | 'invited';

export interface AIDisclosureMatch {
  category: AIDisclosureCategory;
  phrase: string;
  excerpt: string;
}

export interface AIDisclosureScanResult {
  matched: boolean;
  matches: AIDisclosureMatch[];
}

interface DisclosurePattern {
  category: AIDisclosureCategory;
  regex: RegExp;
}

const DISCLOSURE_PATTERNS: DisclosurePattern[] = [
  // Mandatory: imperative verbs binding to an AI/LLM disclosure noun.
  // Match shape: <verb-phrase> <AI noun> <disclosure noun>?
  // Verb phrases: "must disclose", "required to disclose", "are required
  // to indicate", "you must indicate". The optional disclosure-action
  // noun catches "must disclose use of AI" without requiring a separate
  // pattern. The AI noun can be plain "ai/llm" or a tool name.
  {
    category: 'mandatory',
    regex:
      /\b(must|required\s+to|are\s+required\s+to)\s+(disclose|indicate|declare|note|state|mention|label|tag|credit|acknowledge)\s+(?:[a-z\s'-]{0,40}?\b)?(ai|llm|generative\s+ai|copilot|chatgpt|claude|cursor)\b/i,
  },
  // "PRs using AI must be labeled / tagged / disclosed"
  {
    category: 'mandatory',
    regex:
      /\b(prs?|contributions?|commits?|code)\s+(using|generated\s+by|written\s+by|made\s+with)\s+(ai|llm|copilot|chatgpt|claude|cursor)\s+(?:tools?\s+)?(must\s+be|need\s+to\s+be|are\s+to\s+be)\s+(labeled|tagged|disclosed|marked|flagged|noted)\b/i,
  },
  // "Disclosure of AI assistance is required" — passive form
  {
    category: 'mandatory',
    regex:
      /\b(disclosure|disclosing|labeling|labelling|tagging|crediting)\s+(of\s+)?(ai|llm|copilot|chatgpt|claude|cursor)(\s+(use|usage|assistance|tools?|contributions?|generated\s+code))?\s+(is\s+required|is\s+mandatory|must\s+be\s+included)\b/i,
  },

  // Recommended: softer "should" or "we ask" framing. Same noun anchors.
  // Verb forms allow optional gerund (-ing) endings since "we strongly
  // encourage acknowledging AI" reads naturally even though "acknowledge"
  // is the bare verb in the imperative list.
  {
    category: 'recommended',
    regex:
      /\b(should|we\s+ask\s+you\s+to|we\s+ask\s+that\s+you|we\s+(?:strongly\s+)?(?:encourage|recommend))\s+(disclose|disclosing|indicate|indicating|declare|declaring|note|noting|mention|mentioning|label|labeling|labelling|tag|tagging|credit|crediting|acknowledge|acknowledging)\s+(?:[a-z\s'-]{0,40}?\b)?(ai|llm|generative\s+ai|copilot|chatgpt|claude|cursor)\b/i,
  },
  // "credit AI tools you used" — direct imperative without "must/should"
  {
    category: 'recommended',
    regex: /\b(credit|acknowledge|attribute)\s+(ai|llm|generative\s+ai)\s+(tools?|assistants?|use|usage|assistance)\b/i,
  },

  // Invited: permissive framing. Lower confidence.
  // The "please" branch is dropped intentionally — bare "please mention X"
  // doesn't carry enough policy weight on its own, and including it as
  // `please\s+(?:feel\s+free\s+to)?\s+` introduces super-linear backtracking
  // (regexp/no-super-linear-backtracking) because of the ambiguous \s+
  // boundary on either side of the optional group.
  {
    category: 'invited',
    regex:
      /\b(feel\s+free\s+to|please\s+feel\s+free\s+to|you('re|\s+are)\s+welcome\s+to|welcome\s+to)\s+(disclose|mention|note|indicate|label|tag|credit)\s+(?:[a-z\s'-]{0,40}?\b)?(ai|llm|generative\s+ai|copilot|chatgpt|claude|cursor)\b/i,
  },
];

/**
 * Scan repo docs for language requiring or inviting AI disclosure (#1269).
 *
 * Mirrors {@link scanForAntiLLMPolicy}'s shape: same input contract,
 * same false-positive-resistance discipline, same per-match excerpt for
 * surfacing to the user. Categories are ordered by binding strength —
 * callers that want to avoid false-positive flagging on weak invitations
 * can filter to 'mandatory' / 'recommended' only.
 */
export function scanAIDisclosureRequirement(text: string): AIDisclosureScanResult {
  if (typeof text !== 'string') {
    throw new TypeError(`scanAIDisclosureRequirement: expected string, received ${typeof text}`);
  }
  if (text === '') return { matched: false, matches: [] };

  const normalized = normalizeText(text);
  const seenLabels = new Set<string>();
  const matches: AIDisclosureMatch[] = [];

  for (const pattern of DISCLOSURE_PATTERNS) {
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
