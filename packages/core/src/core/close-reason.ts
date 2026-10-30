/**
 * Why a PR was closed without merging (#1824), classified from who closed it
 * and its last few comments. Feeds the outcome ledger so the eval report can
 * tell "superseded" from "maintainer rejected it" from "went stale".
 *
 * Only human, non-author comments count: review bots and welcome templates
 * mention "AI" or "duplicate" constantly without meaning a closure reason.
 *
 * ponytail: keyword heuristics over the last comments. Swap in an LLM pass if
 * `rejected` turns out to hide distinct causes worth separating.
 */

export const CLOSE_REASONS = ['ai-policy', 'superseded', 'stale', 'self-closed', 'rejected', 'unknown'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export interface CloseContext {
  author?: string;
  /** Login of whoever closed the PR; undefined when GitHub reports no actor (ghost). */
  closer?: string;
  closerIsBot?: boolean;
  comments: Array<{ author?: string; isBot?: boolean; body: string }>;
}

// Policy phrasing only: a bare "AI" or "Claude" shows up in ordinary review talk.
const AI_POLICY_RE =
  /\b(?:AI|LLM)[- ](?:generated|written|authored|slop|polic(?:y|ies))|(?:generated|written) (?:by|with) (?:an? )?(?:AI|LLM|ChatGPT|Copilot)\b|vibe[- ]?cod|machine[- ]generated/i;
const SUPERSEDED_RE =
  /clos(?:e|ing) (?:this )?as (?:a )?duplicate|duplicate of #\d+|superseded by|already (?:been )?(?:fixed|merged|addressed|resolved|implemented)|fixed (?:in|by|via) #\d+|in fav(?:ou)?r of #\d+/i;
const STALE_RE = /marked as stale|clos(?:e|ing) (?:this )?(?:as|due to) (?:stale|inactiv)|no activity (?:for|in)/i;

export function classifyCloseReason({ author, closer, closerIsBot, comments }: CloseContext): CloseReason {
  const human = comments.filter((c) => !c.isBot && c.author !== author).map((c) => c.body);
  if (human.some((b) => AI_POLICY_RE.test(b))) return 'ai-policy';
  if (human.some((b) => SUPERSEDED_RE.test(b))) return 'superseded';
  if (closerIsBot || human.some((b) => STALE_RE.test(b))) return 'stale';
  if (!closer) return 'unknown';
  return closer === author ? 'self-closed' : 'rejected';
}
