---
name: oss-guidelines
description: View / edit / reset per-repo contribution guidelines stored from prior extract-learnings runs
allowed-tools: Bash, Read, Write, Edit, Agent, AskUserQuestion
---

# /oss-guidelines [repo]

Surface for the per-repo guidelines machinery (#867 / #1283). Most users
land here after the `extract-learnings` workflow has run at least once
and want to read, edit, or reset what was stored — without re-running
the full extraction.

## Inputs

- `[repo]` — optional. `owner/repo` shorthand. When omitted, this
  command lists every repo with stored guidelines and asks which one
  the user wants to operate on.

## What it does

1. **Resolve the target repo.**
   - If an argument was passed, use it verbatim.
   - Otherwise, enumerate repos with stored guidelines by listing the
     MCP `repo-guidelines` resources (`ListMcpResourcesTool` on the
     oss-autopilot server; each stored repo appears as an
     `oss://repo/{owner}/{repo}/guidelines` resource) and present the
     list via `AskUserQuestion`. The CLI has no enumeration subcommand
     (`guidelines` only supports `view`/`store`/`reset`/`fetch-corpus`,
     all repo-scoped), so when MCP resources are unavailable, ask the
     user for the `owner/repo` directly.
   - If no guidelines exist for any repo, surface a one-line nudge
     toward `extract-learnings` and exit.

2. **Render the current guidelines.**

   ```
   ## Guidelines for {owner}/{repo}
   Stored: {byteSize} bytes, last updated {timestamp}

   {markdown content}
   ```

   Read via `mcp__plugin_oss-autopilot_oss-autopilot__guidelines-get`
   when available; fall back to
   `cli.bundle.cjs guidelines view --repo OWNER/REPO --json` otherwise.

3. **Offer follow-up actions.** Use `AskUserQuestion`:
   - **Re-extract from recent PRs** — dispatches the
     `extract-learnings.md` workflow scoped to this repo.
   - **Edit guidelines** — invokes the `edit-guidelines.md`
     workflow (load → user edit → store, no extraction step).
   - **Reset (delete)** — calls `cli.bundle.cjs guidelines reset --repo
     OWNER/REPO` after a confirm prompt. Tombstones the entry in
     the gist (#867 semantics).
   - **Done** — exit cleanly.

## What it does NOT do

- Does not run the LLM extraction step itself. That belongs to
  `extract-learnings.md`.
- Does not fetch or analyze new PR comments. Read-only over what is
  already stored.
- Does not modify multiple repos in one invocation. Re-run with a
  different `[repo]` arg or pick another from the list.

## Errors

- **No gist persistence configured** — guidelines storage requires
  Gist mode. Surface the standard "this requires Gist persistence;
  run `oss-autopilot setup --set persistence=gist`" message and exit.
- **Repo argument is malformed** — must match `owner/repo`. Validate
  before any CLI call.
- **CLI / MCP failure** — surface the underlying error message and
  exit; do not fabricate a fallback view of the data.

## Why this command exists

The per-repo guidelines machinery has been "data plumbing without a
user surface" since #867 — the only way to interact with stored
guidelines was via the extract-learnings workflow's storage step or
raw CLI. `/oss-guidelines` makes them a first-class object the user
can read and curate.
