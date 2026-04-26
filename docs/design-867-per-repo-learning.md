# Design Document: Issue #867 — Per-Repo Learning from Merged PR Review Feedback

Status: Draft for review (2026-04-26).
Source issue: https://github.com/costajohnt/oss-autopilot/issues/867.

This document is the blueprint requested in option C of the planning pass. It does not commit any code; sign-off here gates the actual PRs in Section 2.

---

## 1. File-by-File Implementation Map

### New Files

#### `packages/core/src/core/pr-comments-fetcher.ts`
Purpose: Fetch all review comments, reviews, and issue comments for a closed/merged PR, filtered to maintainer/reviewer voices only (excluding the user's own comments and bots).

New exports:
```ts
export interface PRCommentBundle {
  prUrl: string;
  prTitle: string;
  repo: string;
  mergedAt: string;          // or closedAt
  reviews: Array<{ author: string; authorAssociation: string; body: string; submittedAt: string }>;
  reviewComments: Array<{ author: string; authorAssociation: string; body: string; path: string; createdAt: string }>;
  issueComments: Array<{ author: string; authorAssociation: string; body: string; createdAt: string }>;
}

export async function fetchPRCommentBundle(
  prUrl: string,
  token: string,
  githubUsername: string,
): Promise<PRCommentBundle>

export async function fetchPRCommentBundlesBatch(
  prUrls: string[],
  token: string,
  githubUsername: string,
  concurrency?: number,
): Promise<PRCommentBundle[]>
```

Rough size: ~110 lines. Follows the exact same pagination pattern as `comments.ts` using `paginateAll`. Filters: skip comments where `author === githubUsername`, skip bot authors via `isBotAuthor()`. Includes `authorAssociation` so the extraction prompt can weight OWNER/MEMBER/COLLABORATOR comments more heavily.

#### `packages/core/src/commands/guidelines.ts`
Purpose: CLI commands for `guidelines view`, `guidelines edit`, `guidelines reset`, and the internal `guidelines fetch-corpus` plumbing command.

New exports:
```ts
export interface GuidelinesViewOutput {
  repo: string;
  content: string | null;     // null = no guidelines yet
  byteSize: number;
  exists: boolean;
  storageMode: 'gist' | 'local-unavailable';
}

export interface GuidelinesStoreOutput {
  repo: string;
  byteSize: number;
  stored: boolean;
}

export interface GuidelinesResetOutput {
  repo: string;
  deleted: boolean;
}

export interface FetchCorpusOutput {
  repo: string;
  bundles: PRCommentBundle[];
  prCount: number;
  skipped: number;     // PRs with learningsExtractedAt already set
}

export async function runGuidelinesView(options: { repo: string }): Promise<GuidelinesViewOutput>
export async function runGuidelinesStore(options: { repo: string; content: string }): Promise<GuidelinesStoreOutput>
export async function runGuidelinesReset(options: { repo: string }): Promise<GuidelinesResetOutput>
export async function runFetchCorpus(options: { repo: string; limit?: number; forceRefetch?: boolean }): Promise<FetchCorpusOutput>
```

`runFetchCorpus` fetches comment bundles for merged/closed PRs for the repo that do NOT yet have `learningsExtractedAt` set (unless `forceRefetch`). It respects the `limit` cap (default 5). Returns raw bundles; the extraction step is the host's responsibility.

Rough size: ~200 lines.

#### `packages/core/src/core/guidelines-store.ts`
Purpose: Thin wrapper over `GistStateStore.getDocument` / `setDocument` / `listDocuments` that encodes the `guidelines--{owner}--{repo}.md` filename convention, enforces the byte-budget cap, and handles the local-mode "not available" case gracefully.

New exports:
```ts
export const GUIDELINES_FILE_PREFIX = 'guidelines--';
export const GUIDELINES_MAX_BYTES = 8_192;   // 8 KB — see Decision Log

export function guidelinesFilename(repo: string): string
  // Returns: "guidelines--owner--repo.md" (slashes replaced with --)

export function getGuidelines(store: GistStateStore, repo: string): string | null
export function setGuidelines(store: GistStateStore, repo: string, content: string): void
  // Throws if content.length > GUIDELINES_MAX_BYTES
export function deleteGuidelines(store: GistStateStore, repo: string): void
export function listGuidelinesRepos(store: GistStateStore): string[]
  // Returns "owner/repo" strings derived from filenames with GUIDELINES_FILE_PREFIX

export class GuidelinesNotAvailableError extends OssAutopilotError {}
  // Thrown when StateManager is not in Gist mode
```

Rough size: ~80 lines.

#### `packages/core/src/core/guidelines-store.test.ts`
Purpose: Unit tests for the guidelines store layer.
Rough size: ~100 lines.

#### `packages/core/src/core/pr-comments-fetcher.test.ts`
Purpose: Unit tests for the comment-fetching pipeline with mocked Octokit.
Rough size: ~120 lines.

#### `packages/core/src/commands/guidelines.test.ts`
Purpose: Integration tests for the four `guidelines` commands with an in-memory StateManager.
Rough size: ~150 lines.

### Files Modified

#### `packages/core/src/core/state-schema.ts` — lines 53-65 (StoredMergedPR/StoredClosedPR)
Add `commentsFetchedAt?: string` to both schemas. This is separate from the existing `learningsExtractedAt` which tracks when the host performed LLM extraction. `commentsFetchedAt` tracks when the raw comment bundle was last fetched from GitHub, enabling cache-friendly re-fetch decisions without re-fetching the full corpus each daily run.

Also bump `AgentStateSchema` version literal from `z.literal(3)` to `z.literal(4)` and add migration. See Section 4 for full diff.

#### `packages/core/src/core/state.ts` — ~line 415 region (Merged PR Storage)
Add two new methods to `StateManager`:
```ts
markPRCommentsFetched(url: string, fetchedAt: string): void
markPRLearningsExtracted(url: string, extractedAt: string): void
```

Both find the PR by URL in `mergedPRs` or `closedPRs` and set the respective timestamp field, then call `autoSave()`. Currently `learningsExtractedAt` has no setter — this makes the mutation explicit.

#### `packages/core/src/core/state.ts` — new `GuidelinesStore` delegation methods
Add to `StateManager`:
```ts
getGuidelines(repo: string): string | null
setGuidelines(repo: string, content: string): void
deleteGuidelines(repo: string): void
listGuidelinesRepos(): string[]
isGuidelinesAvailable(): boolean   // true iff gistStore !== null
```

These delegate to `guidelines-store.ts` helpers. When `gistStore` is null (local mode), `getGuidelines` returns `null`, `setGuidelines`/`deleteGuidelines` throw `GuidelinesNotAvailableError`, and `isGuidelinesAvailable` returns `false`.

#### `packages/core/src/commands/index.ts`
Add exports:
```ts
export { runGuidelinesView, runGuidelinesStore, runGuidelinesReset, runFetchCorpus } from './guidelines.js';
export type { GuidelinesViewOutput, GuidelinesStoreOutput, GuidelinesResetOutput, FetchCorpusOutput } from './guidelines.js';
```

#### `packages/core/src/cli-registry.ts`
Register four new CLI commands:
- `guidelines view --repo <owner/repo>` (localOnly: false — needs Gist)
- `guidelines store --repo <owner/repo> --content <markdown>` (localOnly: false)
- `guidelines reset --repo <owner/repo>` (localOnly: false)
- `guidelines fetch-corpus --repo <owner/repo> [--limit N] [--force]` (localOnly: false)

The `store` command in standalone CLI mode outputs: `"Per-repo guidelines require Gist persistence. Run \`oss-autopilot setup\` and enable Gist sync to use this feature."` See Decision Log §8.

#### `packages/core/src/formatters/json.ts`
Add output type exports for `GuidelinesViewOutput`, `GuidelinesStoreOutput`, `GuidelinesResetOutput`, `FetchCorpusOutput` (re-exported from `commands/guidelines.ts`).

#### `packages/mcp-server/src/tools.ts`
Add three new MCP tools (tools 24, 25, 26):

```ts
// 24. guidelines-get
server.registerTool('guidelines-get', {
  description: 'Retrieve per-repo learning guidelines for a repository. Returns null content if no guidelines exist yet.',
  inputSchema: { repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be owner/repo format') },
  annotations: { readOnlyHint: true },
}, wrapTool(runGuidelinesView));

// 25. guidelines-store
server.registerTool('guidelines-store', {
  description: 'Persist per-repo guidelines extracted from PR review feedback. Overwrites existing guidelines for the repo.',
  inputSchema: {
    repo: z.string().regex(/^[^/]+\/[^/]+$/),
    content: z.string().min(1).max(8192),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, wrapTool(({ repo, content }) => runGuidelinesStore({ repo, content })));

// 26. guidelines-fetch-corpus
server.registerTool('guidelines-fetch-corpus', {
  description: 'Fetch raw review comment bundles for a repo\'s recent merged/closed PRs. Returns data for the host to run extraction on. Does not call any LLM.',
  inputSchema: {
    repo: z.string().regex(/^[^/]+\/[^/]+$/),
    limit: z.number().int().min(1).max(10).optional().describe('Max PRs to process (default 5)'),
    forceRefetch: z.boolean().optional().describe('Re-fetch even if commentsFetchedAt is already set'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, wrapTool(runFetchCorpus));
```

Import `runGuidelinesView`, `runGuidelinesStore`, `runFetchCorpus` from `@oss-autopilot/core/commands`.

#### `packages/mcp-server/src/resources.ts`
Add one new dynamic resource template (resource 6):

```ts
server.registerResource(
  'repo-guidelines',
  new ResourceTemplate('oss://repo/{owner}/{repo}/guidelines', { list: async () => {
    const repos = getStateManager().listGuidelinesRepos();
    return { resources: repos.map(r => {
      const [owner, repo] = r.split('/');
      return { uri: `oss://repo/${owner}/${repo}/guidelines`, name: r, mimeType: 'text/markdown' };
    }) };
  }}),
  { title: 'Repo Guidelines', description: 'Per-repo learning guidelines extracted from past PR feedback.', mimeType: 'text/markdown' },
  async (uri, { owner, repo }) => {
    const content = getStateManager().getGuidelines(`${String(owner)}/${String(repo)}`);
    if (!content) throw new Error(`No guidelines for ${String(owner)}/${String(repo)}`);
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }] };
  }
);
```

#### `packages/mcp-server/src/prompts.ts`
Add one new prompt (prompt 4):

```ts
server.registerPrompt(
  'extract-learnings',
  {
    title: 'Extract Per-Repo Learnings',
    description: 'Given raw PR comment bundles, produce a structured guidelines document for a repo',
    argsSchema: {
      repo: z.string().describe('owner/repo'),
      corpus: z.string().describe('JSON-serialized PRCommentBundle[]'),
      existingGuidelines: z.string().optional().describe('Current guidelines content if any (for incremental update)'),
    },
  },
  async ({ repo, corpus, existingGuidelines }) => {
    let bundles: PRCommentBundle[];
    try { bundles = JSON.parse(corpus); } catch { return userMessage(`Invalid corpus JSON`); }
    const prList = bundles.map(b =>
      `### ${b.prTitle} (${b.prUrl}, merged/closed: ${b.mergedAt})\n` +
      [...b.reviews.map(r => `[REVIEW by ${r.author} (${r.authorAssociation})]\n${r.body}`),
       ...b.reviewComments.map(c => `[INLINE on ${c.path} by ${c.author}]\n${c.body}`),
       ...b.issueComments.map(c => `[COMMENT by ${c.author}]\n${c.body}`)
      ].join('\n\n')
    ).join('\n\n---\n\n');
    const existing = existingGuidelines ? `\n\nEXISTING GUIDELINES (update incrementally):\n${existingGuidelines}` : '';
    return userMessage(EXTRACT_LEARNINGS_PROMPT(repo, prList, existing));
  }
);
```

`EXTRACT_LEARNINGS_PROMPT` is a module-level function returning the extraction prompt string (see Section 5 for what it says). Rough prompt size: ~50 lines of instruction.

#### `packages/mcp-server/README.md`
Update the tool count from 22 to 25 (3 new tools). Update the table to list `guidelines-get`, `guidelines-store`, `guidelines-fetch-corpus`. Update the resources count from 5 to 6. Update the prompts count from 3 to 4.

#### `workflows/work-through-issues.md` — Section 4 "Vet the selected issue" / "After selecting issue"
After feasibility analysis completes (Step 5 of issue investigation), add a new sub-step before "Post-investigation options":

```
**5b. Inject Repo Guidelines (if available)**

Fetch per-repo guidelines for `{owner}/{repo}`:

GUIDELINES=$(GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" guidelines view --repo {owner}/{repo} --json)

If `data.exists` is true and `data.content` is non-empty, display:

> **Maintainer preferences for {owner}/{repo}** (from past PR feedback):
> {data.content}
>
> These preferences take precedence over CONTRIBUTING.md when they conflict.

If `data.exists` is false, skip silently.
If the command fails (not in Gist mode, network error), skip silently — never block claim on guidelines unavailability.
```

#### `commands/oss.md` — Summary section, startup data
No change needed to the startup flow itself. The guidelines injection happens inside `work-through-issues.md` at claim time. The `oss.md` router routes to that workflow unchanged.

#### `agents/issue-scout.md` (or whichever agent handles issue feasibility)
Add a note at the end of the feasibility report step: "If per-repo guidelines were injected at claim time, reference them when assessing approach and flag if your proposed implementation conflicts with a stated maintainer preference."

---

## 2. PR Sequencing

### PR 1: `feat: add commentsFetchedAt/learningsExtractedAt setters + v4 state migration`
Files touched:
- `packages/core/src/core/state-schema.ts` — add `commentsFetchedAt` to both stored-PR schemas; bump schema version to 4
- `packages/core/src/core/state-persistence.ts` — add `migrateV3ToV4` (no-op field addition, just version bump)
- `packages/core/src/core/state.ts` — add `markPRCommentsFetched` and `markPRLearningsExtracted` methods
- `packages/core/src/core/state.test.ts` — tests for new setters and migration

What ships: The lowest-risk foundation. Adds fields and migration with no user-visible behavior change. Enables subsequent PRs to use the new fields without re-opening the schema.

Blocked behind: Nothing.

Convention: `feat:` (adds new fields, minor bump).

Review surface: Small. Schema diff + two setters + migration test.

### PR 2: `feat: guidelines-store — Gist freeform document API for per-repo guidelines`
Files touched:
- `packages/core/src/core/guidelines-store.ts` — new file
- `packages/core/src/core/guidelines-store.test.ts` — new file
- `packages/core/src/core/state.ts` — add `getGuidelines`, `setGuidelines`, `deleteGuidelines`, `listGuidelinesRepos`, `isGuidelinesAvailable` delegation methods
- `packages/core/src/core/index.ts` — export `GuidelinesNotAvailableError`, `guidelinesFilename`, `GUIDELINES_MAX_BYTES`

What ships: The Gist freeform-document API. `GistStateStore.getDocument`/`setDocument`/`listDocuments` already exist — this PR adds the naming convention, byte-budget enforcement, and the `StateManager` façade. Can be unit-tested fully in-memory without a real Gist.

Blocked behind: Nothing (does not depend on PR 1 schema changes, the new fields are separate concerns).

Convention: `feat:`.

Review surface: Small-Medium. Core library code, well-bounded.

### PR 3: `feat: pr-comments-fetcher — fetch raw comment bundles for closed/merged PRs`
Files touched:
- `packages/core/src/core/pr-comments-fetcher.ts` — new file
- `packages/core/src/core/pr-comments-fetcher.test.ts` — new file

What ships: The GitHub data-fetching layer. Pure data plumbing — calls Octokit, filters authors, returns `PRCommentBundle[]`. No LLM calls, no state mutations beyond the `markPRCommentsFetched` call (which requires PR 1).

Blocked behind: PR 1 (uses `markPRCommentsFetched`).

Convention: `feat:`.

Review surface: Small. One new module with mocked tests.

### PR 4: `feat: guidelines CLI commands (view/store/reset/fetch-corpus)`
Files touched:
- `packages/core/src/commands/guidelines.ts` — new file
- `packages/core/src/commands/guidelines.test.ts` — new file
- `packages/core/src/commands/index.ts` — add exports
- `packages/core/src/cli-registry.ts` — register four commands
- `packages/core/src/formatters/json.ts` — add output type exports

What ships: The standalone CLI surface. `guidelines view` works in both Gist and local modes (returns null in local mode). `guidelines store`/`reset`/`fetch-corpus` surface the `GuidelinesNotAvailableError` as `"not available"` in local mode. Users can immediately call `guidelines view` to check if guidelines exist, and `guidelines fetch-corpus` to get raw data for manual extraction.

Blocked behind: PR 2 (uses `guidelines-store.ts`), PR 3 (uses `pr-comments-fetcher.ts`).

Convention: `feat:`.

Review surface: Medium. Four command functions + CLI registration.

### PR 5: `feat(mcp): add guidelines-get, guidelines-store, guidelines-fetch-corpus tools + extract-learnings prompt + repo guidelines resource`
Files touched:
- `packages/mcp-server/src/tools.ts` — add 3 tools (24, 25, 26)
- `packages/mcp-server/src/resources.ts` — add resource 6
- `packages/mcp-server/src/prompts.ts` — add prompt 4
- `packages/mcp-server/README.md` — update counts and tables

What ships: Full MCP surface. MCP clients (including the Claude Code plugin via MCP) can now call `guidelines-fetch-corpus` to get raw PR comment data, then invoke `extract-learnings` to get a structured extraction prompt, then call `guidelines-store` to persist the result. The `oss://repo/{owner}/{repo}/guidelines` resource lets MCP clients read guidelines before starting work.

Blocked behind: PR 4 (imports command functions).

Convention: `feat:`.

Review surface: Medium. Three tool registrations follow the exact same `wrapTool()` pattern as existing tools — low risk of divergence.

### PR 6: `feat(plugin): inject per-repo guidelines at claim time in work-through-issues workflow`
Files touched:
- `workflows/work-through-issues.md` — add Step 5b guidelines injection
- `agents/issue-scout.md` (or applicable agent) — add guidelines reference note

What ships: The end-to-end user-visible behavior. When a user picks an issue from the curated list and investigation completes, guidelines for that repo are fetched and surfaced. Works via both the CLI bundle and MCP depending on which deployment model is active.

Blocked behind: PR 4 (CLI command must exist before the workflow can invoke it).

Convention: `feat:`.

Review surface: Small. Markdown-only changes.

### PR 7: `feat(plugin): add extract-learnings workflow trigger to post-PR merge flow`
Files touched:
- `workflows/work-through-issues.md` — add optional "Extract learnings from this PR?" step after merge confirmation
- `agents/pr-health-checker.md` or similar — add note about triggering extraction on merge

What ships: The "close the loop" UX. After a PR is confirmed merged (end of a daily check cycle), offer the user the option to run extraction on that PR's review feedback. Calls `guidelines-fetch-corpus` then `extract-learnings` prompt, then `guidelines-store`.

Blocked behind: PR 5 (MCP prompt must exist), PR 6 (claim-time injection context is needed to know what this updates).

Convention: `feat:`.

Review surface: Small-Medium. Adds a non-blocking optional step to an existing workflow.

---

## 3. Decision Log

### File Size Budget
Cap: 8,192 bytes (8 KB).

Rationale: The primary injection context is claim time inside the `/oss` plugin workflow. At that point, the model already holds the issue body (~1–2 KB), CONTRIBUTING.md (~2–4 KB), feasibility analysis (~1 KB), and the issue conversation (~1–2 KB). A 200K-token context window has effectively unlimited headroom for a small guidelines document, but the practical risk is different: this text is injected into every new-contribution session for the repo, so it accumulates across sessions. Setting 8 KB as the hard ceiling keeps any single repo's guidelines well under 1% of context budget while still allowing hundreds of guidelines entries. The `setGuidelines` function in `guidelines-store.ts` throws synchronously at this limit; the MCP tool schema enforces `z.string().max(8192)` at the boundary. Users who need larger guidelines should split them — the format uses five fixed categories so splitting by category is natural.

### Consolidation Cadence
Decision: On-demand only, triggered explicitly by the user or MCP client. No automatic consolidation.

Rationale: Automatic consolidation requires the LLM to rewrite the guidelines document — this is non-trivial logic that should not happen silently in the background. The alternatives (time-based: too fragile across idle periods; count-based: requires knowing when to trigger; on-demand: puts the user in control) were evaluated. On-demand wins because: (1) the TypeScript layer cannot perform consolidation without calling an LLM, which violates the rigid data-plumbing-only rule in the constraint; (2) the MCP `extract-learnings` prompt already handles incremental update (it accepts `existingGuidelines` and returns an updated version); (3) users contribute to most repos infrequently — consolidation pressure rarely builds fast enough to warrant automation.

### "Other" Category Promotion to Named Category
Decision: Never automatic. The extraction prompt instructs the host to use "Other" only when a comment does not fit Code Style, Process, Architecture, Testing, or Testing Infrastructure. Promotion from "Other" to a named category happens only when the user explicitly runs a consolidation pass and instructs the host to re-categorize.

Rationale: Automatic promotion requires repeated LLM invocations on stored text and introduces false categorizations that erode trust in the guidelines over time. The five fixed categories cover the vast majority of real review feedback. "Other" is a safe fallback for edge cases (e.g., repo-specific tooling preferences, CI constraints) that do not map cleanly. Leaving them in "Other" is honest; silently re-categorizing them via heuristic pattern matching would be both brittle and invisible to the user.

### Multi-Maintainer Consensus
Decision: Weight by `authorAssociation`. Comments from authors with `OWNER`, `MEMBER`, or `COLLABORATOR` association (as returned by GitHub's REST API `author_association` field) are treated as authoritative maintainer guidance. Comments from `CONTRIBUTOR` (non-member past contributor) or `NONE` (first-time commenter) are treated as community feedback and included but labeled `[community]` in the corpus passed to the extraction prompt. The extraction prompt instructs the host to treat OWNER/MEMBER/COLLABORATOR comments as the definitive signal and to flag contradictions between maintainer comments at the same association level rather than resolving them.

Rationale: GitHub's `author_association` field is already available on every comment in the Octokit REST response (`pulls.listReviews`, `pulls.listReviewComments`, `issues.listComments`), so no extra API call is needed. Using it avoids the complexity of tracking reviewer frequency across PRs (which would require a separate state index), while still capturing the semantically meaningful distinction between project insiders and external commenters. "Repo owner by count" heuristics would be easily confused by active external contributors and would require a separate counting pass.

### Recency Weighting
Decision: Cliff at 12 months. PRs older than 12 months from the current date at fetch time are excluded from the corpus passed to the extraction prompt. PRs within 12 months are included with equal weight.

Rationale: Smooth decay requires the TypeScript layer to embed recency scores in the corpus and instruct the LLM to weight accordingly, which adds fragile prompt engineering. A cliff is deterministic, simple to implement (a single date comparison in `runFetchCorpus`), and aligned with real-world maintenance: a repo's conventions rarely change faster than yearly, and 12 months ensures at least one full review cycle is captured for actively maintained repos. For repos with very few PRs, the `limit` parameter already bounds corpus size — the age filter is a safety net, not the primary size control. The 12-month threshold is not configurable in v1; if users report it's too aggressive, it can be surfaced as a config key later.

### Signal vs. Noise Extraction
Decision: The `extract-learnings` prompt must include explicit rules distinguishing durable guidance from PR-specific nitpicks. The concrete rules for the extraction prompt:

**Keep as durable guidance:**
1. Naming convention preferences stated as a general rule: "In this repo we use camelCase for event names, not kebab-case."
2. Test requirements: "Every new public function needs a unit test." / "Test files live in `__tests__/` not `*.test.ts`."
3. Code organization: "Business logic must not live in route handlers — extract to a service layer."
4. Process requirements: "Update the CHANGELOG entry in the same commit as the code change."
5. Architecture constraints: "Don't add new direct DB queries to the controller layer; use the repository pattern."
6. Documentation requirements: "Every exported type needs a JSDoc comment."
7. CI/tooling requirements: "Run `pnpm format` before pushing — the formatter check is blocking."
8. PR hygiene rules that apply to all PRs: "Squash to a single commit before merge."
9. Dependency constraints: "Don't add new transitive dependencies without maintainer approval."
10. Reviewer-stated project philosophy: "We prefer explicit over implicit — avoid magic defaults."

**Discard as PR-specific noise:**
1. Approval/acknowledgment: "LGTM!", "Looks good to me!", "Thanks!"
2. Scope-specific ask about that exact PR: "Can you also update the README for this specific change?"
3. One-time workaround: "For this PR, just use `any` to unblock — we'll fix the type later."
4. Status update: "I'll review this tomorrow.", "Assigned to @colleague."
5. CI flakiness note: "The test is flaky, don't worry about it in this PR."
6. Typo-only fix request: "s/recieve/receive/ in the comment."
7. Style preference stated only about the specific code touched: "I'd format this particular block differently..." (no general rule implied).
8. Historical context without actionable rule: "We tried this approach before and it didn't scale, but it's fine here."

### Backfill Scope
Decision: 5 most recent merged/closed PRs. This is the hard default for `runFetchCorpus` when no `limit` is specified, and it is also the cap for the first-time backfill scenario.

Rationale: The issue says "consider 3-5 most recent PRs." 5 is the upper bound because it keeps the corpus under 100 typical review comments (reasonable for a single extraction prompt invocation), while still capturing enough feedback to identify recurring patterns. 3 is too few for repos where the user's first PR got through with minimal feedback. 5 balances coverage vs. prompt size. The `limit` parameter in `runFetchCorpus` allows users to override upward (to 10 max, enforced in the Zod schema) for repos where they have extensive history.

### Standalone CLI Fallback
Decision: Commands that require Gist mode emit the following message when the StateManager is not in Gist mode:

```
Per-repo guidelines require Gist persistence.
Run `oss-autopilot setup` to enable Gist sync, then retry.
Error code: GUIDELINES_NOT_AVAILABLE
```

With `--json`, this surfaces as:
```json
{ "success": false, "error": "Per-repo guidelines require Gist persistence. Run `oss-autopilot setup` to enable Gist sync, then retry.", "errorCode": "GUIDELINES_NOT_AVAILABLE", "timestamp": "..." }
```

Affected commands: `guidelines store`, `guidelines reset`, `guidelines fetch-corpus`. `guidelines view` returns `{ exists: false, content: null, storageMode: "local-unavailable" }` as a non-error response — the information is just unavailable, not an error condition.

The `GUIDELINES_NOT_AVAILABLE` error code is added to the `ErrorCode` union in `formatters/json.ts`.

---

## 4. State Schema Diff

Current schema version: 3. New schema version: 4.

**Changes to `StoredMergedPRSchema`** (currently lines 53-58 in `state-schema.ts`):

```ts
// BEFORE:
export const StoredMergedPRSchema = z.object({
  url: z.string(),
  title: z.string(),
  mergedAt: z.string(),
  learningsExtractedAt: z.string().optional(),
});

// AFTER:
export const StoredMergedPRSchema = z.object({
  url: z.string(),
  title: z.string(),
  mergedAt: z.string(),
  commentsFetchedAt: z.string().optional(),     // NEW: when raw comments were last fetched
  learningsExtractedAt: z.string().optional(),
});
```

**Changes to `StoredClosedPRSchema`** (currently lines 60-65):

```ts
// BEFORE:
export const StoredClosedPRSchema = z.object({
  url: z.string(),
  title: z.string(),
  closedAt: z.string(),
  learningsExtractedAt: z.string().optional(),
});

// AFTER:
export const StoredClosedPRSchema = z.object({
  url: z.string(),
  title: z.string(),
  closedAt: z.string(),
  commentsFetchedAt: z.string().optional(),     // NEW
  learningsExtractedAt: z.string().optional(),
});
```

**Change to `AgentStateSchema`** (line 280, currently `z.literal(3)`):

```ts
// BEFORE:
export const AgentStateSchema = z.object({
  version: z.literal(3),
  ...
});

// AFTER:
export const AgentStateSchema = z.object({
  version: z.literal(4),
  ...
});
```

**Migration function in `state-persistence.ts`** (add after `migrateV2ToV3`):

```ts
/**
 * Migrate state from v3 to v4.
 * Adds: commentsFetchedAt field on StoredMergedPR and StoredClosedPR (optional, defaults to undefined).
 * No data is dropped. Existing optional fields on PR entries are preserved.
 * This is a schema-only bump — Zod optional fields mean no actual data transformation is needed.
 */
export function migrateV3ToV4(rawState: Record<string, unknown>): Record<string, unknown> {
  debug(MODULE, 'Migrating state from v3 to v4 (add commentsFetchedAt to stored PR records)...');
  rawState.version = 4;
  debug(MODULE, 'v3 to v4 migration complete (no data transformation required).');
  return rawState;
}
```

**Migration chain wiring** in `gist-state-store.ts` (`parseStateFromCache`) and `state-persistence.ts` (`loadState`): add `if (record.version === 3) obj = migrateV3ToV4(obj as Record<string, unknown>);` after the existing `version === 2` check.

**Inferred type exports** — add to the inferred types block at the bottom of `state-schema.ts`:
No new top-level type exports needed — `StoredMergedPR` and `StoredClosedPR` already have their inferred types exported; the new field is automatically included.

**Default values:** Both new `commentsFetchedAt` fields default to `undefined` via Zod's `.optional()`. No Zod `.default()` is needed. Migration is a no-op for existing data.

---

## 5. Test Plan

### `packages/core/src/core/guidelines-store.test.ts` (new)
1. `guidelinesFilename` correctly encodes `owner/repo` as `guidelines--owner--repo.md`.
2. `setGuidelines` writes content to the Gist store cache and marks the file dirty.
3. `getGuidelines` returns null for a repo with no file in cache.
4. `getGuidelines` returns content for a repo that has been set.
5. `setGuidelines` throws `GuidelinesNotAvailableError` when called on the StateManager in local mode (no gistStore).
6. `setGuidelines` throws when content exceeds `GUIDELINES_MAX_BYTES`.
7. `deleteGuidelines` removes the file from the cache.
8. `listGuidelinesRepos` returns `[]` when no guidelines files exist.
9. `listGuidelinesRepos` returns the correct `owner/repo` list when multiple guideline files exist.
10. Round-trip: set, get, delete, get returns null.

Testing approach: Use `GistStateStore` constructed with a mock `OctokitLike` (same pattern as `gist-state-store.test.ts`). No real network calls.

### `packages/core/src/core/pr-comments-fetcher.test.ts` (new)
1. `fetchPRCommentBundle` returns a well-formed `PRCommentBundle` for a valid PR URL.
2. Bot comments (login contains `[bot]` or is in `KNOWN_BOT_USERNAMES`) are excluded.
3. The authenticated user's own comments are excluded.
4. `authorAssociation` is included on all comment entries.
5. `fetchPRCommentBundle` throws `ValidationError` for a non-PR URL.
6. Paginated reviews (more than 100 comments) are fully returned (verify `paginateAll` is called with the correct endpoints).
7. `fetchPRCommentBundlesBatch` processes multiple PRs up to the concurrency limit and returns all bundles.
8. `fetchPRCommentBundlesBatch` continues processing remaining PRs if one fails (non-fatal partial failure).

Testing approach: Mock Octokit endpoints using the same `vi.fn()` pattern as `pr-monitor.test.ts` or `issue-conversation.ts` tests.

### `packages/core/src/commands/guidelines.test.ts` (new)
1. `runGuidelinesView` returns `{ exists: false, storageMode: 'local-unavailable' }` when StateManager is in local mode.
2. `runGuidelinesView` returns `{ exists: false, content: null }` when in Gist mode but no guidelines exist for the repo.
3. `runGuidelinesView` returns the stored content when guidelines exist.
4. `runGuidelinesStore` persists content and calls `StateManager.setGuidelines`.
5. `runGuidelinesStore` returns a `GuidelinesNotAvailableError`-derived error in local mode.
6. `runGuidelinesReset` deletes guidelines and returns `deleted: true`.
7. `runGuidelinesReset` returns `deleted: false` when no guidelines exist for the repo.
8. `runFetchCorpus` fetches comment bundles for merged PRs without `commentsFetchedAt` set.
9. `runFetchCorpus` skips PRs that already have `commentsFetchedAt` set (unless `forceRefetch: true`).
10. `runFetchCorpus` respects the `limit` parameter.
11. `runFetchCorpus` excludes PRs older than 12 months.

Testing approach: Use `StateManager` in-memory mode with a mock Gist store for store/get tests. Mock `fetchPRCommentBundlesBatch` to avoid real network calls.

### `packages/core/src/core/state.test.ts` (extend existing)
Add to the "Merged PR Storage" and "Closed PR Storage" sections:
1. `markPRCommentsFetched` sets `commentsFetchedAt` on the matching merged PR entry.
2. `markPRCommentsFetched` is a no-op when no PR with the given URL exists.
3. `markPRLearningsExtracted` sets `learningsExtractedAt` on the matching merged PR entry.
4. `markPRCommentsFetched` and `markPRLearningsExtracted` both call `autoSave`.
5. v3-to-v4 migration round-trips correctly: a v3 state parses as v4 with `commentsFetchedAt: undefined` on all PR entries.

### `packages/core/src/core/gist-state-store.test.ts` (extend existing)
Add to the "bootstrap" and "push" sections:
1. A Gist that contains both `state.json` and a `guidelines--owner--repo.md` file populates both in the in-memory cache after `bootstrap`.
2. `setDocument` on a guidelines filename marks it dirty, and `push` sends it as part of the file update.
3. `listDocuments('guidelines--')` returns the filenames of all guidelines files loaded from the Gist.

### Extraction Prompt Corpus Harness (qualitative, not automated)
This is a manual rubric test, not a vitest file. It should be documented in this design doc and run before shipping PR 5.

**Rubric:** For each of three representative repos from the user's history, manually run `guidelines fetch-corpus --repo owner/repo --json`, pipe the output to the `extract-learnings` MCP prompt, and verify the output against these criteria:
- Category coverage: the output has at least 3 of the 5 fixed categories if the corpus has relevant comments.
- Signal filtering: no PR-specific nitpicks appear as durable guidance (verify against the 8-item discard list in Decision Log §6).
- Contradiction flagging: if the corpus contains two maintainer comments that contradict each other on the same topic, both are represented with a `[CONFLICT]` annotation rather than one being silently dropped.
- Author weighting: OWNER/MEMBER/COLLABORATOR comments appear; NONE/CONTRIBUTOR comments appear only when they provide clear project-wide guidance.
- Size: output is under 6,000 bytes (leaves headroom below the 8,192 cap).
- Incremental update: run extraction a second time with `existingGuidelines` set; verify the output deduplicates without losing new information.

---

## 6. Open Follow-Ups

These items were identified as out-of-scope for this feature and should be filed as separate issues:

1. **Guidelines for local-mode users.** The current design gates all guidelines on Gist mode. Local-mode users who want per-repo learning would need to maintain guideline files themselves. A future issue could add an optional local file path (`~/.oss-autopilot/guidelines/{owner}-{repo}.md`) as a local-mode fallback.
2. **Guideline version history / diffing.** The Gist file is overwritten on each `guidelines-store` call. There is no history of how guidelines evolved. A future issue could add versioned snapshots or use the Gist revision history API to show what changed between extractions.
3. **Sharing guidelines across team members.** The current design treats guidelines as per-user (stored in the user's own Gist). For teams where multiple contributors work on the same repos, a shared read-only guidelines file (separate Gist or GitHub repo file) would reduce duplication. Out of scope for v1.
4. **Guidelines for issue conversations.** The issue mentions issue conversations as a source of guidance. The current design focuses on PR review comments only. A follow-up issue could extend `runFetchCorpus` to also fetch issue conversations for issues where the user commented but the issue was closed without a linked PR (a "failed claim" signal).
5. **Auto-expiry of old guidelines entries.** The current design has no mechanism to remove individual guidance entries that become stale (e.g., the repo migrated to a different linter). A future issue could add a `guidelines consolidate` command that runs a consolidation pass on demand and asks the user to approve deprecating entries older than N months.
6. **Dashboard visualization.** The `packages/dashboard` SPA currently has no panel for per-repo guidelines. A separate issue could add a "Repo Guidelines" tab showing the repos with guidelines, their sizes, and last-extracted-at timestamps.
7. **`extract-learnings` prompt as a standalone skill file.** The extraction prompt is currently embedded in `prompts.ts` as a module-level string. For the Claude Code plugin layer (non-MCP users), the same prompt logic should be exposed as a `skills/per-repo-learning/SKILL.md` file. This was deferred because the plugin layer's claim-time flow already invokes MCP or CLI; a pure-markdown skill file would duplicate the prompt. A separate issue should decide the right abstraction.

---

Sources:
- `packages/core/src/core/state-schema.ts` — schema version, `StoredMergedPRSchema`, `StoredClosedPRSchema`
- `packages/core/src/core/gist-state-store.ts` — `getDocument`/`setDocument`/`listDocuments`, ETag/concurrency model
- `packages/core/src/core/state.ts` — `StateManager` class structure, `addMergedPRs`/`addClosedPRs`
- `packages/mcp-server/src/tools.ts` — 22 existing tools, `wrapTool` pattern
- `packages/mcp-server/src/resources.ts` — 5 existing resources, `ResourceTemplate` pattern
- `packages/mcp-server/src/prompts.ts` — 3 existing prompts, `userMessage` pattern
- `packages/mcp-server/README.md` — tool count: 22, resource count: 5, prompt count: 3
- `packages/core/src/commands/comments.ts` — `runComments` pattern for PR comment fetching
- `packages/core/src/core/comment-utils.ts` — `isBotAuthor` utility
- `workflows/work-through-issues.md` — claim-time flow, feasibility assessment structure
- `packages/core/src/core/state-persistence.ts` — migration chain pattern (`migrateV2ToV3`)
