---
name: oss-overnight
description: "Overnight prepare-and-queue run: check PRs, prepare fix branches in worktrees, write a morning report. Never pushes, posts, or merges."
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task
---

# OSS Overnight Run

Unattended version of `/oss` (#1574). It runs the same daily check, prepares
code work in isolated worktrees, and writes a morning report you read at
`/oss` time. It is built to run headlessly from launchd, so it never asks a
question and never touches GitHub beyond reads.

## Hard gates (the feature, not a limitation)

- **No external side effects.** No `git push`, no `gh pr create`, no `gh pr comment`,
  no `gh issue comment`, no `gh pr merge`, no `gh run rerun`. Every agent you
  dispatch gets this list verbatim. If an agent reports it pushed or posted
  anything, record that in the report under "Check problems" so it is visible.
- **No questions.** There is nobody to answer. When an item needs a decision,
  leave it in "Needs your judgment" and move on.
- **Prepared work stays local.** A prepared branch lives in a worktree under
  `~/.oss-autopilot/worktrees/`. The morning `/oss` run is where you push it,
  through the normal draft-approval workflow.

## Step 1: Run the check and write the report

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" overnight run --json
```

The CLI resolves its GitHub token itself (`GITHUB_TOKEN`, then `gh auth token`),
so no shell wrapper is needed; the headless allowlist has no `bash`. If node
reports the bundle is missing, stop and print that error: `/oss` builds the
bundle on every interactive run, so run `/oss` once before scheduling this.

Parse the JSON envelope. `data` has:

| Field | Meaning |
|-------|---------|
| `reportPath` | The morning report (markdown). Everything below appends to it. |
| `prepare` | Items an agent can work on without external side effects: `ci_failing`, `merge_conflict`, `needs_changes`, `incomplete_checklist`. Each has `url`, `label`, `reason`. |
| `judgment` | Items that need you: maintainer replies to answer, issue conversations with a new response. Already in the report; do nothing with them. |
| `failures`, `warnings` | Already in the report, one line per PR that could not be fetched. |
| `carriedPrepared` | Branches kept from an earlier run today; a re-run never drops recorded work. |
| `gistSyncWarning` | Present when the run could not be pushed to the Gist. Append it under "Check problems". |

If `success` is false, print the error and stop. The report is not written on failure, so the next `/oss` shows the previous run's freshness, which is the correct signal.

## Step 2: Prepare each item, one agent at a time

For each entry in `data.prepare`, in order, dispatch **one** `overnight-preparer`
agent (Task tool, `subagent_type: "oss-autopilot:overnight-preparer"`) and wait
for it before dispatching the next. Sequential on purpose: this runs on the
user's machine at night, beside nothing else, and one full test suite at a time
is what a laptop can take. Do not substitute `pr-health-checker`: its charter
includes rebase-and-push and maintainer comments, which this run must never do.
The preparer's own definition carries the prepare-only charter, the worktree
layout, and the report shape, so the prompt is one line:

```
OVERNIGHT PREPARE-ONLY MODE for {url} ({label}: {reason}). Report in your four-line shape.
```

After the agent returns:

- `STATUS: prepared` → record it:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" overnight record \
    --url "{url}" --branch "{BRANCH}" --worktree "{WORKTREE}" --note "{NOTE}" --json
  ```
- `STATUS: blocked` → append one line to the report file under a `## Blocked` heading
  (create it if missing): `- {label} {url} — {NOTE}`. Do not retry.
- Agent failed or returned nothing → same as blocked, with the note `agent returned no result`.

## Step 3: Finish

Print, in this order:

1. `Overnight report: <reportPath>`
2. `Prepared: <n>  Blocked: <m>  Needs your judgment: <data.judgment.length>`

Then stop. `/oss` surfaces this report at the next startup.

## Scheduling

The CLI renders the launchd job:

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" overnight schedule --hour 2 --claude-path "$(command -v claude)" --install
```

It writes `~/Library/LaunchAgents/com.oss-autopilot.overnight.plist` and prints
the `launchctl bootstrap` command to load it. The job runs
`claude -p "/oss-overnight" --permission-mode dontAsk --allowedTools "<list>"`:
headless runs start in manual permission mode where any unapproved tool call
fails, so the plist pre-approves exactly the tools this command uses and
nothing that mutates remote state: file tools, Task, git subcommands except
`push`, the read side of `gh` (`pr view/checks/diff/list`, `run view/list`,
`issue view`, `repo view`; no `gh api`), and `node`/`pnpm`/`npm` for the CLI
and test suites. No `bash`, `sh`, or `npx`. A deny list (`--disallowedTools`,
deny beats allow) additionally names `git push`, every `gh pr`/`gh issue`
write, `gh run rerun`, `gh api`, and `AskUserQuestion`. The preparer agent's
charter repeats the gate so an interactive `/oss-overnight` behaves the same. If running a repo's test
suite under your own credentials is more trust than you want, run the job as
a dedicated user with no push credentials. Two caveats
from the headless docs: a bare `claude -p` reads `ANTHROPIC_API_KEY` from the
environment (add it to the plist's `EnvironmentVariables` if your login is
not picked up), and logs go to `~/.oss-autopilot/reports/overnight-launchd.log`.
