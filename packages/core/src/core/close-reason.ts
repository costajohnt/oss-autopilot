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

/**
 * Why the author closed their own PR (#1824): the "self-closed" bucket is
 * most closures, and "I withdrew it" hides three different stories.
 */
export const SELF_CLOSE_REASONS = ['superseded', 'no-traction', 'after-feedback', 'no-response'] as const;
export type SelfCloseReason = (typeof SELF_CLOSE_REASONS)[number];

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
  /clos(?:e|ing) (?:this )?as (?:a )?duplicate|duplicate of #\d+|superseded by|already (?:been )?(?:fixed|merged|addressed|resolved|implemented)|fixed (?:in|by|via) #\d+|in favou?r of #\d+/i;
const STALE_RE = /marked as stale|clos(?:e|ing) (?:this )?(?:as|due to) (?:stale|inactiv)|no activity (?:for|in)/i;

// The author's own explanation, phrased the way real closing comments are:
// "v0.6 covers this", "#1684 landed the same fix", "#1408 is in", "in favor of #6087".
const AUTHOR_SUPERSEDED_RE =
  /already (?:been )?(?:fixed|merged|addressed|resolved|implemented|landed|applied|several)|cover(?:s|ed) (?:this|everything|the same)|(?:landed|fixed|ships?) the same|same (?:one-line )?fix|has (?:landed|shipped)|is in and|(?:fixed|addressed|resolved|landed|applied) (?:upstream|elsewhere)|upstream (?:upgrade|commit|fix)|supersed|in favou?r of|replaced by|duplicate|no longer (?:needed|relevant|reproduc|applies)/i;
// Withdrawn because nobody picked it up.
const NO_TRACTION_RE =
  /traction|(?:been )?quiet|unmaintained|actively (?:reviewing|maintained)|not maintained|no (?:response|activity)|keep the queue tidy|sitting in (?:your|the) queue|stale/i;

/**
 * Split an author-closed PR by what preceded the close. Call only when
 * {@link classifyCloseReason} returned 'self-closed'.
 */
export function classifySelfClose({ author, comments }: CloseContext): SelfCloseReason {
  const own = comments.filter((c) => !c.isBot && c.author === author).map((c) => c.body);
  if (own.some((b) => AUTHOR_SUPERSEDED_RE.test(b))) return 'superseded';
  if (own.some((b) => NO_TRACTION_RE.test(b))) return 'no-traction';
  return comments.some((c) => !c.isBot && c.author !== author) ? 'after-feedback' : 'no-response';
}

export function classifyCloseReason({ author, closer, closerIsBot, comments }: CloseContext): CloseReason {
  const human = comments.filter((c) => !c.isBot && c.author !== author).map((c) => c.body);
  if (human.some((b) => AI_POLICY_RE.test(b))) return 'ai-policy';
  if (human.some((b) => SUPERSEDED_RE.test(b))) return 'superseded';
  if (closerIsBot || human.some((b) => STALE_RE.test(b))) return 'stale';
  if (!closer) return 'unknown';
  return closer === author ? 'self-closed' : 'rejected';
}
