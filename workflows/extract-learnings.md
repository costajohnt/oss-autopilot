# Extract Per-Repo Learnings (#867)

> **Trigger:** User asks "extract learnings for {repo}" or invokes `/oss extract` on a repo. Also dispatched automatically, in the background, by `/oss` startup and `/oss-overnight` when `daily` reports `pendingLearnings` (#1696) — see "Auto mode" below.
>
> **Prerequisite:** Gist persistence is enabled. Standalone-mode users see a "not available" message at the storage step.

## Auto mode (#1696)

When the dispatching prompt says **AUTO MODE**, there is no user to ask. Run the steps below with these differences:

- Step 1: the repos come from the prompt; process them one at a time.
- Step 3: if `data.failures` is non-empty, report `failed — <failures[0].error>` and stop for this repo (Step 7 unrun, so the next run retries); a PR that never fetched is not "no signal". `fetch-corpus` stamps `commentsFetchedAt` before any extraction, so `data.prCount === 0` with `data.skipped > 0` means an earlier run fetched but never finished: re-run with `--force` once, then continue. `data.prCount === 0`, `data.skipped === 0` and no failures means no corpus: run Step 7 and report `no signal`.
- Step 5: skip the confirmation. Store directly (Step 6) unless the extraction produced malformed markdown or the corpus had nothing beyond LGTM-style approvals, in which case store nothing, still run Step 7, and report `no signal`.
- Step 4: a subagent cannot invoke the MCP prompt. Distill inline instead, following the same rules: five fixed categories (Code Style, Process, Architecture, Testing, Other), maintainer voices (OWNER/MEMBER/COLLABORATOR) weighted over community comments, contradictions flagged rather than resolved, PR-specific nitpicks dropped, merged into `existingGuidelines` rather than replacing it.
- Steps 6 and 7: if either response carries `gistSyncWarning`, the stamp or the guidelines did not reach the Gist (the source of truth on the next bootstrap), so report `failed — <gistSyncWarning>`, not `updated`.
- Failure modes: never prompt. Report `failed — <reason>` and leave Step 7 unrun so the next run retries. The line the host prints for a failed repo names `autoExtractLearnings=false` as the way to stop retrying.
- Shell: run the CLI as a bare `node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" ...` command and read the JSON from the tool result. No `GITHUB_TOKEN=$(gh auth token)` prefix, no `EXISTING=$(...)` capture, no `echo ... |` pipe: the CLI resolves the token itself, and the overnight allowlist admits `node *` only, so a command whose first word is an assignment or `echo` is refused. Store with `guidelines store --repo {owner}/{repo} --content '<markdown>' --json` (single-quote the markdown; it contains no single quotes in practice, and if it does, replace them with ’ before storing).

Everything else (weighting, categories, byte budget) is unchanged.

---

## Overview

This workflow takes raw review feedback from the user's recent merged/closed PRs in a repo and distills it into a structured guidelines markdown file stored in the user's Gist. Future contributions to the same repo automatically inject these guidelines at claim time (see `workflows/work-through-issues.md` Step 7) so the agent doesn't rediscover the same maintainer preferences PR by PR.

The CLI/MCP layer is pure data plumbing. The actual extraction (signal-vs-noise, category placement, deduplication) happens via the host LLM consuming the `extract-learnings` MCP prompt.

---

## Steps

### 1. Confirm the target repo

Default: the repo whose PR most recently merged. Otherwise: ask the user which repo to process. Validate the format `owner/repo` before proceeding.

### 2. Check existing guidelines

Read what's already stored so the extraction can update incrementally rather than rewriting from scratch:

```bash
EXISTING=$(GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" guidelines view --repo {owner}/{repo} --json)
```

If `data.storageMode === 'local-unavailable'`, stop and tell the user:

> Per-repo guidelines require Gist persistence. Run `oss-autopilot setup` to enable Gist sync, then retry.

If `data.exists === false`, this is a first-time extraction. If `data.exists === true`, capture `data.content` as `existingGuidelines` for the prompt.

### 3. Fetch the corpus

Pull raw PR comment bundles for the most recent unprocessed merged/closed PRs:

```bash
CORPUS=$(GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" guidelines fetch-corpus --repo {owner}/{repo} --json)
```

Parse:

- `data.prCount === 0` and `data.skipped === 0`: no eligible PRs (none merged in last 12 months for this repo). Stop and tell the user there's no corpus to extract from.
- `data.prCount === 0` and `data.skipped > 0`: every PR has already been processed. Ask the user if they want to re-fetch via `--force` or stop here.
- `data.prCount > 0`: capture `data.bundles` as the corpus for the next step.

The default limit is 5 PRs. Pass `--limit N` (max 10) if the user wants more, or `--force` to re-fetch already-processed PRs.

### 4. Run the extraction prompt

Invoke the `extract-learnings` MCP prompt with the corpus and existing guidelines:

```
extract-learnings({
  repo: '{owner}/{repo}',
  corpus: JSON.stringify(data.bundles),
  existingGuidelines: existingContent || undefined,
})
```

The prompt produces a structured markdown document with five fixed categories: Code Style, Process, Architecture, Testing, Other. Maintainer voices (OWNER/MEMBER/COLLABORATOR) are weighted higher than community comments, contradictions are flagged rather than silently resolved, and PR-specific nitpicks are filtered out per the design log §6.

### 5. Show the user the result

Display the extracted markdown so the user can review before persisting:

> **Proposed guidelines for {owner}/{repo}** ({byteSize} bytes):
>
> {extracted markdown}

Then confirm:

```
Question: "Persist these guidelines to your Gist?"
Header: "Store guidelines"

Options:
1. "Yes, store" — "Save and inject on future PRs in this repo"
2. "Edit first" — "I want to tweak the markdown before storing"
3. "Discard" — "Don't store; this run was just an experiment"
```

### 6. Store the guidelines

If the user approves (with or without edits), persist via `guidelines store`:

```bash
echo "{final markdown}" | GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" guidelines store --repo {owner}/{repo} --json
```

The CLI reads from stdin when `--content` is omitted, which is the expected path for non-trivial markdown to avoid shell-quoting issues.

If the response is `success: true`, the guidelines are now live for the next claim-time injection. Confirm to the user:

> Stored {byteSize} bytes of guidelines for {owner}/{repo}. The next time you claim an issue in this repo, these will be injected before implementation.

### 7. Mark PRs as processed

`guidelines fetch-corpus` already stamped `commentsFetchedAt` on every PR it fetched, so they won't be re-fetched by the default invocation. After the store (or after deciding the corpus had no signal), stamp `learningsExtractedAt` so `daily` stops counting these PRs as unextracted:

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" guidelines mark-extracted --repo {owner}/{repo} --json
```

`data.marked` is how many PRs were stamped. Skip this step when the extraction failed, so the next run retries.

---

## Post-merge handling

With the default `autoExtractLearnings: true`, `daily` reports freshly merged PRs in `pendingLearnings` and `/oss` startup (or `/oss-overnight`) runs this workflow in auto mode without asking (#1696). With `autoExtractLearnings: false`, the action menu carries an `extract_learnings` item instead and the user decides. Do not add a per-merge prompt on top of either path.

---

## When to skip extraction entirely

- The PR was merged with no maintainer review (no comments, no reviews). There's no signal to extract.
- The PR was merged with a single LGTM-style approval. Same.
- The user explicitly tells you they don't want guidelines for this repo (e.g., a one-off contribution they don't expect to repeat).

---

## Failure modes

| Failure | Action |
|---|---|
| `guidelines fetch-corpus` rate-limited | Tell the user, ask if they want to retry now or defer |
| Extraction prompt produces malformed markdown | Don't store. Show the output, ask the user if they want to retry the prompt or edit manually |
| `guidelines store` returns `GUIDELINES_TOO_LARGE` | Show the byte count, ask the user to trim or split across categories |
| Network error mid-flow | Capture progress, offer to resume |

The whole workflow is best-effort. Failures should never block the next contribution cycle; in auto mode a failed repo is simply retried on the next run.
