/**
 * Shared comment utility functions used by both PRMonitor and IssueConversationMonitor.
 * Extracted to avoid circular dependencies between the two modules.
 */

// Bot accounts that don't follow the [bot] suffix convention
const KNOWN_BOT_USERNAMES = new Set([
  'allcontributors',
  'changeset-bot',
  'claassistant',
  'codecov-commenter',
  'copilot',
  'greenkeeper',
  'imgbot',
  'netlify',
  'renovate',
  'snyk-bot',
  'sonarcloud',
  'stale',
  'vercel',
  'web-flow',
]);

/**
 * Check if a comment author is a bot account.
 * Matches the [bot] suffix convention (GitHub Apps; the GraphQL path maps
 * `__typename: 'Bot'` to it), user-account bots named `*-bot` / `*-robot`
 * (e.g. `miq-bot`, `k8s-ci-robot`), known bot usernames (case-insensitive),
 * and REST `user.type === 'Bot'` when the caller has it (e.g. `Copilot`).
 */
export function isBotAuthor(author: string, userType?: string | null): boolean {
  if (userType === 'Bot') return true;
  const lower = author.toLowerCase();
  return (
    lower.includes('[bot]') || lower.endsWith('-bot') || lower.endsWith('-robot') || KNOWN_BOT_USERNAMES.has(lower)
  );
}

/**
 * Detect short acknowledgment comments that don't need code or a status change.
 * Such a comment does not mark the PR as needing attention, so a thanks-only
 * comment never reaches pr-responder's `appreciation` rule (#1852 follow-up).
 * Returns true only when: no question mark, matches an acknowledgment keyword, and under 100 chars.
 * Conservative -- missing a real acknowledgment (false negative) is safer than suppressing a substantive response (false positive).
 */
export function isAcknowledgmentComment(body: string): boolean {
  if (!body || body.length > 100) return false;
  if (body.includes('?')) return false;

  const lower = body.toLowerCase();
  const ackKeywords = [
    'thanks',
    'thank you',
    'lgtm',
    'looks good',
    'will review',
    "we'll review",
    "we'll get to this",
    'noted',
    'got it',
    'will look',
    'will check',
  ];

  return ackKeywords.some((kw) => lower.includes(kw));
}

/**
 * Whole-comment phrases that add nothing to a thread once emoji, emoji
 * shortcodes and punctuation are stripped (#1862).
 */
const LOW_SIGNAL_PHRASES = new Set([
  '+1',
  'bump',
  'same',
  'same here',
  'same issue',
  'same problem',
  'me too',
  'me as well',
  'any update',
  'any updates',
  'any news',
  'following',
  'subscribed',
  'ping',
  'up',
]);

/**
 * The low-signal phrases that ask whoever is working on the issue for a
 * status ("any update?", "ping"). On a claimed issue they are addressed to
 * the claimant, so the engaged rule surfaces them there; "+1" and "same
 * here" are addressed to nobody and stay out.
 */
const STATUS_NUDGES = new Set(['any update', 'any updates', 'any news', 'ping']);

/** The comment's words: emoji, shortcodes and punctuation stripped, lower-cased. */
function significantWords(body: string): string {
  return body
    .replaceAll(/:[\w+-]+:/g, ' ')
    .replaceAll(/[^\p{L}\p{N}+]+/gu, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Whether a comment is a reaction rather than a reply (#1862): nothing but
 * emoji, `:shortcode:`s or punctuation, or one of the "+1" / "same here" /
 * "any update" phrases. Used on engaged issues, where any substantive
 * non-bot comment counts as a reply, to keep me-too traffic out. Anything
 * longer or wordier passes: a false negative here surfaces one extra reply,
 * a false positive hides one.
 */
export function isReactionOnlyComment(body: string): boolean {
  const words = significantWords(body);
  return words === '' || LOW_SIGNAL_PHRASES.has(words);
}

/**
 * Whether a comment is a bare status request ("Any update?", "ping") (#1862).
 * A subset of {@link isReactionOnlyComment}: these read as reactions on an
 * issue the user only commented on, but on a claimed issue they ask the
 * claimant, so the monitor counts them there.
 */
export function isStatusNudge(body: string): boolean {
  return STATUS_NUDGES.has(significantWords(body));
}

/**
 * Shortest quoted line that identifies a comment. Short lines ("> LGTM",
 * "> yes, agreed") recur across unrelated comments, so a quote that short
 * says nothing about who is being answered.
 */
const MIN_QUOTE_LENGTH = 20;

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * The lines of `body` the author wrote themselves: Markdown `>` quotes,
 * fenced code blocks and indented code are dropped. Quoted text belongs to
 * someone else, and a pasted stack trace or error line is likely to be
 * pasted by others too, so neither identifies the author's comment.
 */
function ownProseLines(body: string): string[] {
  const lines: string[] = [];
  let isInFence = false;
  for (const line of body.split('\n')) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      isInFence = !isInFence;
      continue;
    }
    const isQuoteOrCode = /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line);
    if (!isInFence && !isQuoteOrCode) lines.push(line);
  }
  return lines;
}

/**
 * The prose of `body` with code and quotes removed: `>` quote lines, fenced
 * and indented code blocks (see {@link ownProseLines}) and inline `code`
 * spans. An @mention inside any of those is someone else's words or a
 * literal, not an address to the user (#1857).
 */
export function proseWithoutCode(body: string): string {
  return ownProseLines(body)
    .join('\n')
    .replaceAll(/`[^`\n]*`/g, ' ');
}

/**
 * Whether `body` quotes `quoted` (#1862): a Markdown `>` block in `body`
 * contains a line (at least `MIN_QUOTE_LENGTH` characters once whitespace is
 * collapsed) that appears verbatim in the prose of `quoted`. GitHub's "Quote
 * reply" copies the quoted comment line by line with a `> ` prefix, so a
 * reply built that way is addressed to the quoted comment's author as
 * explicitly as an @mention. Nested quotes (`> > text`) in `body` are read
 * too. Only the prose the author of `quoted` wrote counts as theirs: a quote
 * they included, or an error line they pasted, matches a later quote of the
 * same text without the reply being aimed at them (see {@link ownProseLines}).
 */
export function isQuoteReplyTo(body: string, quoted: string): boolean {
  const source = collapseWhitespace(ownProseLines(quoted).join('\n')).toLowerCase();
  if (source.length < MIN_QUOTE_LENGTH) return false;
  for (const line of body.split('\n')) {
    if (!line.trimStart().startsWith('>')) continue;
    const text = collapseWhitespace(line.replace(/^\s*(?:>\s*)+/, '')).toLowerCase();
    if (text.length >= MIN_QUOTE_LENGTH && source.includes(text)) return true;
  }
  return false;
}
