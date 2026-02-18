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
  'greenkeeper',
  'imgbot',
  'netlify',
  'renovate',
  'snyk-bot',
  'sonarcloud',
  'stale',
  'vercel',
]);

/**
 * Check if a comment author is a bot account.
 * Matches the [bot] suffix convention and known bot usernames (case-insensitive).
 */
export function isBotAuthor(author: string): boolean {
  return author.includes('[bot]') || KNOWN_BOT_USERNAMES.has(author.toLowerCase());
}

/**
 * Detect acknowledgment comments that don't require a response.
 * Returns true only when: no question mark, matches an acknowledgment keyword, and under 100 chars.
 * Conservative -- missing a real acknowledgment (false negative) is safer than suppressing a substantive response (false positive).
 */
export function isAcknowledgmentComment(body: string): boolean {
  if (!body || body.length > 100) return false;
  if (body.includes('?')) return false;

  const lower = body.toLowerCase();
  const ackKeywords = [
    'thanks', 'thank you', 'lgtm', 'looks good',
    'will review', "we'll review", "we'll get to this",
    'noted', 'got it', 'will look', 'will check',
  ];

  return ackKeywords.some(kw => lower.includes(kw));
}
