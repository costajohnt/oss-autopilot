/**
 * Wrap GitHub-sourced text (PR titles, PR bodies, issue bodies, review
 * comments) in a fenced delimiter so the LLM treats it as data, not
 * instructions (#1192).
 *
 * The contract this module pins, exercised by `untrusted-content.test.ts`
 * and the prompt-injection corpus:
 *
 *  1. Output starts with the open tag and ends with the close tag.
 *  2. The close-tag literal NEVER appears inside the wrapped body — any
 *     occurrence in the input is escaped to a sentinel so an attacker
 *     cannot close the fence early and inject instructions after it.
 *  3. `extractFromFence(wrapUntrustedContent(x, label))` returns `x`
 *     unchanged for any input — the wrapping is lossless.
 *
 * Runtime wiring (#1372) — body fields are fenced at the last serialization
 * boundary into agent-facing output:
 *
 *  - `runComments` (commands/comments.ts): review / inline / discussion
 *    comment bodies in the `comments` CLI `--json` + MCP tool output.
 *  - `deduplicateDigest` (formatters/json.ts) and the MCP PR resources:
 *    `openPRs[].lastMaintainerComment.body` via {@link fenceFetchedPR}
 *    (#1420).
 *  - `fetchPRCommentBundle` (core/pr-comments-fetcher.ts): bundle bodies
 *    feeding `guidelines fetch-corpus` (agent-only consumer).
 *  - `toDailyOutput` (commands/daily.ts): `commentedIssues[].lastResponseBody`
 *    / `userLastCommentBody` in the daily/startup JSON. The producer
 *    (`issue-conversation.ts`) stays raw because the dashboard SPA and the
 *    CLI text renderers consume the same objects.
 *
 * Human-facing display paths unwrap with {@link safeExtractFromFence}.
 * This pairs with the agent-side guidance in `workflows/reference.md`
 * ("Prompt Injection Awareness"), which tells the LLM to treat anything
 * inside `<github-content>` blocks as data, not instructions.
 *
 * Non-goals:
 *  - This is NOT a content filter. We do not detect or strip prompt-
 *    injection payloads; the human-in-the-loop gate on `post`/`claim`
 *    remains the primary control.
 */

export const UNTRUSTED_OPEN_TAG_NAME = 'github-content';
export const UNTRUSTED_CLOSE_TAG = `</${UNTRUSTED_OPEN_TAG_NAME}>`;

/**
 * Sentinels used to neutralize any literal open- or close-tag substring
 * inside the wrapped body. We use HTML entity escapes (`&lt;` / `&gt;`) so
 * the result is pure ASCII, lints cleanly, and round-trips losslessly. The
 * `&` itself is escaped first so an input containing the literal text
 * `&lt;/github-content&gt;` survives the wrap/unwrap round-trip without
 * collision.
 */
const AMP_ESCAPE = '&amp;';
const CLOSE_TAG_ESCAPE = `&lt;/${UNTRUSTED_OPEN_TAG_NAME}&gt;`;
const OPEN_TAG_PATTERN = new RegExp(`<${UNTRUSTED_OPEN_TAG_NAME}\\b`, 'g');
const OPEN_TAG_ESCAPE = `&lt;${UNTRUSTED_OPEN_TAG_NAME}`;

export interface UntrustedContentMeta {
  /** GitHub login of the content's author (e.g. PR comment author). */
  author?: string;
  /** GitHub author_association (OWNER, MEMBER, CONTRIBUTOR, NONE, ...). */
  association?: string;
  /** Free-form provenance label (e.g. "pr-body", "review-comment"). */
  source?: string;
}

function escapeAttr(value: string): string {
  // Newlines/carriage returns can't break out of a quoted attribute (no `"`)
  // but they visually fragment the open tag in the prompt text the LLM
  // reads, so encode them as numeric entities for defense-in-depth.
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

/**
 * Wrap `text` in a `<github-content>` fence labeled with `label` and the
 * optional metadata. Any occurrence of the close-tag literal inside `text`
 * is replaced with a zero-width-joined sentinel that round-trips losslessly
 * via {@link extractFromFence}.
 */
export function wrapUntrustedContent(text: string, label: string, meta: UntrustedContentMeta = {}): string {
  // Escape order matters for round-trip correctness:
  //  1. `&` first — so any pre-existing entity in the input gets a literal
  //     `&amp;` that survives the unwrap pass below.
  //  2. Close-tag literals — replaced with the entity-escaped form.
  //  3. Open-tag literals (matched only at boundaries via OPEN_TAG_PATTERN
  //     so we don't accidentally rewrite the close-tag's `</github-content`).
  const escapedBody = text
    .split('&')
    .join(AMP_ESCAPE)
    .split(UNTRUSTED_CLOSE_TAG)
    .join(CLOSE_TAG_ESCAPE)
    .replace(OPEN_TAG_PATTERN, OPEN_TAG_ESCAPE);
  const attrs: string[] = [`label="${escapeAttr(label)}"`];
  if (meta.author !== undefined) attrs.push(`author="${escapeAttr(meta.author)}"`);
  if (meta.association !== undefined) attrs.push(`association="${escapeAttr(meta.association)}"`);
  if (meta.source !== undefined) attrs.push(`source="${escapeAttr(meta.source)}"`);
  return `<${UNTRUSTED_OPEN_TAG_NAME} ${attrs.join(' ')}>${escapedBody}${UNTRUSTED_CLOSE_TAG}`;
}

/**
 * Reverse of {@link wrapUntrustedContent}. Extracts the original body text
 * (un-escaping any sentinel-encoded close tags). Throws if the input is not
 * a single well-formed fence — callers shouldn't be parsing arbitrary
 * markdown with this; it's for tests + symmetric reasoning only.
 */
export function extractFromFence(fenced: string): string {
  const openMatch = fenced.match(new RegExp(`^<${UNTRUSTED_OPEN_TAG_NAME}\\b[^>]*>`));
  if (!openMatch) {
    throw new Error('extractFromFence: input does not start with a <github-content> open tag');
  }
  if (!fenced.endsWith(UNTRUSTED_CLOSE_TAG)) {
    throw new Error('extractFromFence: input does not end with </github-content>');
  }
  const inner = fenced.slice(openMatch[0].length, fenced.length - UNTRUSTED_CLOSE_TAG.length);
  if (inner.includes(UNTRUSTED_CLOSE_TAG)) {
    throw new Error('extractFromFence: nested </github-content> found in body — fence escaping is broken');
  }
  // Reverse the escapes in opposite order: tag entities first (so an
  // already-`&amp;`-prefixed entity survives), then unescape `&amp;`.
  return inner
    .split(CLOSE_TAG_ESCAPE)
    .join(UNTRUSTED_CLOSE_TAG)
    .split(OPEN_TAG_ESCAPE)
    .join(`<${UNTRUSTED_OPEN_TAG_NAME}`)
    .split(AMP_ESCAPE)
    .join('&');
}

/**
 * Tolerant unwrap for human-facing display paths (CLI text mode). Returns
 * the original body when `text` is a well-formed fence, and `text` unchanged
 * otherwise. Display code must not crash on unfenced input (older state,
 * fields that were never wrapped), so unlike {@link extractFromFence} this
 * never throws.
 */
export function safeExtractFromFence(text: string): string {
  try {
    return extractFromFence(text);
  } catch {
    return text;
  }
}

/**
 * Fence the attacker-controllable maintainer-comment excerpt on a FetchedPR
 * for agent-facing serialization (#1420). Applied at the serialization
 * boundary (daily/startup --json via deduplicateDigest, MCP PR resources)
 * rather than at fetch time: extractMaintainerActionHints parses the RAW
 * body inside the pipeline, and human surfaces (dashboard SPA, CLI text
 * mode) must not render fence markup. Returns a copy; never mutates.
 */
export function fenceFetchedPR<T extends FenceablePR>(pr: T): T {
  if (!pr.lastMaintainerComment) return pr;
  return {
    ...pr,
    lastMaintainerComment: {
      ...pr.lastMaintainerComment,
      body: wrapUntrustedContent(pr.lastMaintainerComment.body, `${pr.repo}#${pr.number}`, {
        author: pr.lastMaintainerComment.author,
        source: 'pr-comment',
      }),
    },
  };
}

/** Structural slice of FetchedPR that {@link fenceFetchedPR} needs — kept
 * structural to avoid an import cycle with types.ts consumers. */
interface FenceablePR {
  repo: string;
  number: number;
  lastMaintainerComment?: {
    author: string;
    body: string;
    createdAt: string;
  };
}
