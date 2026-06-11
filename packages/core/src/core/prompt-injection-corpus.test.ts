/**
 * Regression corpus for prompt-injection fencing (#1192).
 *
 * For every known-shape attack payload, asserts that `wrapUntrustedContent`
 * produces a fence with the structural properties described in the helper:
 * exactly one open and one close tag, lossless round-trip, payload contained.
 *
 * Asserting "the LLM ignores this" requires running the model and is
 * inherently flaky / expensive — that's not what this corpus is for. This
 * corpus exists so any future change to the fencing helper that breaks the
 * structural contract (e.g. removing the close-tag escape, or letting the
 * helper interpolate text inside an attribute without escaping) trips a
 * deterministic CI failure.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  wrapUntrustedContent,
  extractFromFence,
  UNTRUSTED_OPEN_TAG_NAME,
  UNTRUSTED_CLOSE_TAG,
} from './untrusted-content.js';
import { PROMPT_INJECTION_PAYLOADS } from './__fixtures__/prompt-injection-payloads.js';

const mocks = vi.hoisted(() => ({
  getOctokit: vi.fn(),
  requireGitHubToken: vi.fn().mockReturnValue('fake-token'),
  stateManager: {
    getState: () => ({ config: { githubUsername: 'testuser' } }),
    getStateStaleness: () => null,
  },
}));

// Partial mock of the core barrel so `runComments` (commands/comments.ts)
// runs its REAL output-mapping code against a fake Octokit. Everything not
// overridden (parseGitHubUrl, the fence helpers, …) stays real.
vi.mock('./index.js', async () => {
  const actual = await vi.importActual<typeof import('./index.js')>('./index.js');
  return {
    ...actual,
    getStateManager: () => mocks.stateManager,
    getOctokit: mocks.getOctokit,
    requireGitHubToken: mocks.requireGitHubToken,
  };
});

describe('prompt-injection corpus (#1192)', () => {
  it('corpus has the categories the threat model references', () => {
    const categories = new Set(PROMPT_INJECTION_PAYLOADS.map((p) => p.category));
    expect(categories).toEqual(
      new Set(['classic', 'fake-system-tag', 'markdown', 'delimiter-collision', 'unicode', 'long']),
    );
    // Pin a minimum so a regression that drops corpus entries gets caught.
    expect(PROMPT_INJECTION_PAYLOADS.length).toBeGreaterThanOrEqual(15);
  });

  describe.each(PROMPT_INJECTION_PAYLOADS)('payload "$name" ($category)', ({ payload }) => {
    const wrapped = wrapUntrustedContent(payload, 'pr-body', { author: 'attacker' });

    it('produces exactly one open tag and one close tag', () => {
      const openCount = wrapped.match(new RegExp(`<${UNTRUSTED_OPEN_TAG_NAME}\\b`, 'g'))?.length ?? 0;
      const closeCount = wrapped.match(new RegExp(`</${UNTRUSTED_OPEN_TAG_NAME}>`, 'g'))?.length ?? 0;
      expect(openCount).toBe(1);
      expect(closeCount).toBe(1);
    });

    it('round-trips through extractFromFence losslessly', () => {
      expect(extractFromFence(wrapped)).toBe(payload);
    });

    it('does not allow the payload to escape the fence boundaries', () => {
      // Find the indices of the open-tag end and close-tag start. Anything
      // between them is "inside the fence". Any substring that looks like an
      // instruction should fall inside that range.
      const openEnd = wrapped.indexOf('>') + 1;
      const closeStart = wrapped.lastIndexOf(`</${UNTRUSTED_OPEN_TAG_NAME}>`);
      expect(openEnd).toBeGreaterThan(0);
      // openEnd === closeStart is legitimate (empty body); only assert the
      // close tag isn't *before* the open tag.
      expect(closeStart).toBeGreaterThanOrEqual(openEnd);

      // For payloads that contain known instruction markers, assert every
      // occurrence in the wrapped output is within the fence interior.
      const markers = ['Ignore previous', 'SYSTEM:', '<system>', '<|im_start|>', '<tool_use>', '<!-- INSTRUCTION'];
      for (const marker of markers) {
        if (!payload.includes(marker)) continue;
        let idx = wrapped.indexOf(marker);
        while (idx !== -1) {
          expect(idx).toBeGreaterThanOrEqual(openEnd);
          expect(idx).toBeLessThan(closeStart);
          idx = wrapped.indexOf(marker, idx + 1);
        }
      }
    });
  });
});

// ── End-to-end layer (#1372) ─────────────────────────────────────────────
//
// A correct helper is worthless if the runtime never calls it — that was the
// original #1372 bug: the fence existed but issue/PR/comment bodies flowed
// raw into agent-facing JSON. These tests run the REAL producers against
// fake GitHub responses whose bodies are the corpus payloads and assert
// every emitted untrusted field is fenced. If someone unwires the fence
// from `runComments`, `fetchPRCommentBundle`, or `toDailyOutput`, this
// suite fails.

/** Assert `emitted` is a single well-formed fence whose body is `original`. */
function expectFenced(emitted: string | null | undefined, original: string): void {
  expect(emitted, 'expected a fenced string, got null/undefined').toBeTypeOf('string');
  const fenced = emitted as string;
  expect(fenced.startsWith(`<${UNTRUSTED_OPEN_TAG_NAME} `), `not fenced: ${fenced.slice(0, 80)}`).toBe(true);
  expect(fenced.endsWith(UNTRUSTED_CLOSE_TAG)).toBe(true);
  // Exactly one close-tag literal in the whole string — any close tag in the
  // payload must have been neutralized inside the fence.
  expect(fenced.split(UNTRUSTED_CLOSE_TAG).length - 1).toBe(1);
  // Lossless: the agent-visible fence still carries the exact original text.
  expect(extractFromFence(fenced)).toBe(original);
}

const PAYLOADS = PROMPT_INJECTION_PAYLOADS.map((p) => p.payload);
/** `runComments` drops reviews whose body is empty/whitespace; the corpus's
 * `empty` payload legitimately never reaches the reviews output. */
const NON_EMPTY_PAYLOADS = PAYLOADS.filter((p) => p.trim().length > 0);

describe('end-to-end: runComments emits fenced bodies (#1372)', () => {
  it('every review, inline-comment, and discussion body in the emitted output is fenced', async () => {
    const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    mocks.getOctokit.mockReturnValue({
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            title: 'Innocent-looking PR',
            state: 'open',
            mergeable: true,
            head: { ref: 'feature' },
            base: { ref: 'main' },
            html_url: 'https://github.com/owner/repo/pull/42',
          },
        }),
        listReviewComments: vi.fn().mockResolvedValue({
          data: PAYLOADS.map((payload, i) => ({
            user: { login: `attacker${i}`, type: 'User' },
            body: payload,
            path: 'src/foo.ts',
            created_at: ts(i),
          })),
        }),
        listReviews: vi.fn().mockResolvedValue({
          data: PAYLOADS.map((payload, i) => ({
            user: { login: `attacker${i}`, type: 'User' },
            state: 'COMMENTED',
            body: payload,
            submitted_at: ts(i),
          })),
        }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({
          data: PAYLOADS.map((payload, i) => ({
            user: { login: `attacker${i}`, type: 'User' },
            body: payload,
            created_at: ts(i),
          })),
        }),
      },
    });

    const { runComments } = await import('../commands/comments.js');
    const result = await runComments({ prUrl: 'https://github.com/owner/repo/pull/42' });

    expect(result.reviews).toHaveLength(NON_EMPTY_PAYLOADS.length);
    expect(result.reviewComments).toHaveLength(PAYLOADS.length);
    expect(result.issueComments).toHaveLength(PAYLOADS.length);

    const collect = (bodies: Array<string | null | undefined>): Set<string> => {
      const extracted = new Set<string>();
      for (const body of bodies) {
        const original = PAYLOADS.find((p) => {
          try {
            return extractFromFence(body as string) === p;
          } catch {
            return false;
          }
        });
        expect(
          original,
          `emitted body is not a fence of any corpus payload: ${String(body).slice(0, 80)}`,
        ).toBeDefined();
        expectFenced(body, original as string);
        extracted.add(original as string);
      }
      return extracted;
    };

    // Every emitted body is fenced AND every corpus payload survived the
    // pipeline (nothing dropped, nothing raw).
    expect(collect(result.reviews.map((r) => r.body))).toEqual(new Set(NON_EMPTY_PAYLOADS));
    expect(collect(result.reviewComments.map((c) => c.body))).toEqual(new Set(PAYLOADS));
    expect(collect(result.issueComments.map((c) => c.body))).toEqual(new Set(PAYLOADS));
  });
});

describe('end-to-end: fetchPRCommentBundle emits fenced bodies (#1372)', () => {
  it('every bundle body is fenced with author/association provenance', async () => {
    const fakeOctokit = {
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: { title: 'Corpus PR', merged_at: '2026-01-02T00:00:00Z', closed_at: null },
        }),
        listReviews: vi.fn().mockResolvedValue({
          data: PAYLOADS.map((payload, i) => ({
            user: { login: `rev${i}` },
            author_association: 'CONTRIBUTOR',
            body: payload,
            submitted_at: '2026-01-01T00:00:00Z',
          })),
        }),
        listReviewComments: vi.fn().mockResolvedValue({
          data: PAYLOADS.map((payload, i) => ({
            user: { login: `inline${i}` },
            author_association: 'NONE',
            body: payload,
            path: 'src/foo.ts',
            created_at: '2026-01-01T00:00:00Z',
          })),
        }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({
          data: PAYLOADS.map((payload, i) => ({
            user: { login: `disc${i}` },
            author_association: 'MEMBER',
            body: payload,
            created_at: '2026-01-01T00:00:00Z',
          })),
        }),
      },
    };

    const { fetchPRCommentBundle } = await import('./pr-comments-fetcher.js');
    const bundle = await fetchPRCommentBundle(fakeOctokit as never, 'https://github.com/owner/repo/pull/7', 'testuser');

    expect(bundle.reviews).toHaveLength(PAYLOADS.length);
    expect(bundle.reviewComments).toHaveLength(PAYLOADS.length);
    expect(bundle.issueComments).toHaveLength(PAYLOADS.length);
    for (const [i, entry] of bundle.reviews.entries()) {
      expectFenced(entry.body, PAYLOADS[i]);
      expect(entry.body).toContain(`author="rev${i}"`);
      expect(entry.body).toContain('source="pr-review"');
    }
    for (const [i, entry] of bundle.reviewComments.entries()) {
      expectFenced(entry.body, PAYLOADS[i]);
      expect(entry.body).toContain('source="pr-review-comment"');
    }
    for (const [i, entry] of bundle.issueComments.entries()) {
      expectFenced(entry.body, PAYLOADS[i]);
      expect(entry.body).toContain('association="MEMBER"');
      expect(entry.body).toContain('source="pr-issue-comment"');
    }
  });
});

describe('end-to-end: toDailyOutput emits fenced commentedIssues bodies (#1372)', () => {
  it('lastResponseBody and userLastCommentBody are fenced in the agent-facing daily JSON', async () => {
    const { toDailyOutput } = await import('../commands/daily.js');
    const { makeDailyDigest, makeCapacityAssessment } = await import('./test-utils.js');

    const commentedIssues = PAYLOADS.map((payload, i) => ({
      repo: 'owner/repo',
      number: i + 1,
      title: `Issue ${i + 1}`,
      url: `https://github.com/owner/repo/issues/${i + 1}`,
      userLastCommentedAt: '2026-01-01T00:00:00Z',
      userLastCommentBody: payload,
      labels: [],
      daysSinceUserComment: 1,
      status: 'new_response' as const,
      lastResponseAuthor: `attacker${i}`,
      lastResponseBody: payload,
      lastResponseAt: '2026-01-02T00:00:00Z',
      isFromMaintainer: false,
    }));

    const output = toDailyOutput({
      digest: makeDailyDigest(),
      capacity: makeCapacityAssessment(),
      summary: '',
      briefSummary: '',
      actionableIssues: [],
      actionMenu: {
        items: [],
        context: {
          hasActionableIssues: false,
          actionableCount: 0,
          hasCapacity: true,
          hasIssueResponses: true,
          issueResponseCount: commentedIssues.length,
        },
      },
      commentedIssues,
      repoGroups: [],
      failures: [],
      warnings: [],
    });

    expect(output.commentedIssues).toHaveLength(PAYLOADS.length);
    for (const [i, issue] of output.commentedIssues.entries()) {
      expectFenced(issue.userLastCommentBody, PAYLOADS[i]);
      expectFenced(issue.lastResponseBody, PAYLOADS[i]);
      expect(issue.lastResponseBody).toContain(`author="attacker${i}"`);
    }
  });
});
