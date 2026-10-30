/**
 * Why a PR was closed without merging (#1824), classified from who closed it
 * and its last few comments. Feeds the outcome ledger so the eval report can
 * tell "superseded" from "maintainer rejected it" from "went stale".
 *
 * ponytail: keyword heuristics over the last comments. Swap in an LLM pass if
 * `rejected` turns out to hide distinct causes worth separating.
 */

export const CLOSE_REASONS = ['ai-policy', 'superseded', 'stale', 'self-closed', 'rejected', 'unknown'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export interface CloseContext {
  author?: string;
  closer?: string;
  comments: Array<{ author?: string; body: string }>;
}

// Case-sensitive `AI`/`LLM` so "said" or "fail" never match.
const AI_ACRONYM_RE = /\b(?:AI|LLMs?)\b/;
const AI_WORDS_RE = /chatgpt|copilot|claude|machine[- ]generated|ai[- ]generated|vibe[- ]?cod/i;
const SUPERSEDED_RE =
  /duplicate|supersed|already (?:been )?(?:fixed|merged|addressed|resolved|implemented)|fixed (?:in|by|via) #|in fav(?:ou)?r of/i;
const STALE_RE = /\bstale\b|inactiv|no (?:recent )?activity/i;
const BOT_RE = /\[bot\]$|^stale/i;

export function classifyCloseReason({ author, closer, comments }: CloseContext): CloseReason {
  const others = comments.filter((c) => c.author !== author).map((c) => c.body);
  if (others.some((b) => AI_ACRONYM_RE.test(b) || AI_WORDS_RE.test(b))) return 'ai-policy';
  if (others.some((b) => SUPERSEDED_RE.test(b))) return 'superseded';
  if ((closer && BOT_RE.test(closer)) || others.some((b) => STALE_RE.test(b))) return 'stale';
  if (!closer) return 'unknown';
  return closer === author ? 'self-closed' : 'rejected';
}
