import { describe, it, expect } from 'vitest';
import { classifyCloseReason } from './close-reason.js';

const ctx = (closer: string | undefined, ...comments: Array<[string, string]>) => ({
  author: 'me',
  closer,
  comments: comments.map(([author, body]) => ({ author, body })),
});

describe('classifyCloseReason (#1824)', () => {
  it.each([
    [ctx('maint', ['maint', 'We do not accept AI generated PRs.']), 'ai-policy'],
    [ctx('maint', ['maint', 'Looks like Copilot wrote this.']), 'ai-policy'],
    [ctx('me', ['maint', 'Closing as duplicate of #12']), 'superseded'],
    [ctx('maint', ['maint', 'This was already fixed in main.']), 'superseded'],
    [ctx('github-actions[bot]'), 'stale'],
    [ctx('maint', ['stale[bot]', 'This PR is stale because it has had no activity.']), 'stale'],
    [ctx('me'), 'self-closed'],
    [ctx('maint', ['maint', 'Not the direction we want, thanks.']), 'rejected'],
    [ctx(undefined), 'unknown'],
  ])('%#: classifies as %s', (input, expected) => {
    expect(classifyCloseReason(input)).toBe(expected);
  });

  it("ignores the author's own comments and lowercase look-alikes", () => {
    expect(classifyCloseReason(ctx('maint', ['me', 'Drafted with AI help'], ['maint', 'said no, fail']))).toBe(
      'rejected',
    );
  });
});
