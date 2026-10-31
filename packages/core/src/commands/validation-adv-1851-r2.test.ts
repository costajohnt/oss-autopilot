import { describe, it, expect } from 'vitest';
import { validateMessage } from './validation.js';

// Round 2 attribution patterns: fenced quotes and negations pass; pasted
// Git-log trailers, bold/emoji footers do not. ("Generated with Claude"
// without "Code" is deliberately not matched: it collides with tools such
// as claude-cli, and the check is best-effort.)
describe('validateMessage L1 round 2', () => {
  it.each([
    // Legit: a reply quoting the trailer it removed, in a fenced block (line-anchored -> rejected).
    'Rebased and dropped this trailer from every commit as requested:\n```\nCo-Authored-By: Claude <noreply@anthropic.com>\n```',
    // Legit: negation.
    'To be clear, none of this was generated with Claude Code; it is hand-written.',
  ])('accepts legitimate content: %s', (msg) => {
    expect(() => validateMessage(msg)).not.toThrow();
  });

  it.each([
    // git log paste: body lines are indented 4 spaces, so ^ never matches.
    'Here is the commit:\n\n    fix: thing\n\n    Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>',
    'Generated with **Claude Code**',
    '🤖 Built with Claude Code',
  ])('rejects real attribution: %s', (msg) => {
    expect(() => validateMessage(msg)).toThrow(/attribution/);
  });
});
