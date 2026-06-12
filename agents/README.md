# Subagents — tool-list rationale

Each agent here declares a narrow `tools:` allowlist rather than the `mcp__*`
wildcard. Wildcards grant access to every MCP server the user has installed
(LinkedIn, Gmail, Telegram, Puppeteer, Serena, etc.) in addition to this
plugin's own MCP server — and that includes tools that post publicly on the
user's behalf.

The global CLAUDE.md rule "never post without showing a draft first" has
two enforcement layers working together: (1) this per-agent allowlist, which
prevents MCP-mediated posting, and (2) the `block-unauthorized-github` and
`check-issue-mentions.sh` PreToolUse hooks, which intercept Bash-based
`gh pr comment`, `gh issue comment`, etc. Prose in the agent body is
advisory; both hard gates must be kept narrow.

## Deliberate exclusions

| Tool | Why no agent declares it |
|---|---|
| `mcp__plugin_oss-autopilot_oss-autopilot__post` | Writes a public GitHub comment. All posting goes through the `draft-review-post` skill so the user reviews the exact body before it ships. |
| `mcp__plugin_oss-autopilot_oss-autopilot__claim` | Posts a claim comment on an issue. Same reason as `post`. |
| `mcp__plugin_oss-autopilot_oss-autopilot__move`, `__dismiss`, `__shelve` (and their inverses) | Mutate `~/.oss-autopilot/state.json`. Agents that need to influence state should produce a recommendation for the parent workflow to act on, not mutate directly. |
| `mcp__linkedin__*`, `mcp__claude_ai_Gmail__*`, `mcp__puppeteer__*`, `mcp__plugin_serena_serena__execute_shell_command` | Out of scope — OSS Autopilot agents should never need cross-channel messaging, arbitrary web control, or sandbox escape. |

## Per-agent allowlists

Every agent additionally grants `AskUserQuestion` — each one runs a mandatory
user-confirmation gate (see "AskUserQuestion Validation Protocol" in
`workflows/reference.md`), so the tool is part of the design, not a
convenience. The frontmatter `tools:` line in each agent file is the source of
truth; `packages/core/src/agents-contract.test.ts` enforces that every tool an
agent's body instructs with is actually granted (#1377).

- `contribution-strategist` — `Bash`, `Read`, `AskUserQuestion`, `mcp__...__strategy` (read-only analyzer; emits a markdown report in chat).
- `issue-scout` — `Bash`, `Read`, `AskUserQuestion`, `mcp__...__search`, `mcp__...__verify-issue`, `mcp__...__vet`, `mcp__...__vet-list`, `mcp__...__status`.
- `pr-compliance-checker` — `Bash`, `Read`, `Glob`, `Grep`, `AskUserQuestion`, `mcp__...__track`, `mcp__...__comments`, `mcp__...__compliance-score`, `mcp__...__guidelines-get`.
- `pr-health-checker` — `Bash`, `Read`, `Grep`, `AskUserQuestion`, `mcp__...__track`, `mcp__...__comments`. (Reads config via the CLI `config --json`; the MCP config tool is a get-or-set mutator and is deliberately not granted.)
- `pr-responder` — `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `AskUserQuestion`, `mcp__...__track`, `mcp__...__comments`, `mcp__...__guidelines-get` (keeps `Write` for drafting response files under `/tmp` and `Edit` for formatting reverts; posting still routes through `draft-review-post`).
- `pre-commit-reviewer` — `Bash`, `Read`, `Glob`, `Grep`, `AskUserQuestion`, `mcp__...__guidelines-get` (local git/diff review).
- `repo-evaluator` — `Bash`, `Read`, `Glob`, `AskUserQuestion`, `mcp__...__vet`, `mcp__...__repo-vet`, `mcp__...__status`.

`track` here is the v2 read-only snapshot tool — it no longer mutates
`~/.oss-autopilot/state.json`, which is why it can be granted despite the
state-mutation exclusion above (the mutating tools — `move`, `dismiss`,
`shelve` and inverses — remain excluded).

## Adding a tool

When a new agent genuinely needs a tool not listed above, add it explicitly —
never use `mcp__*`. CI enforces this via the "Guard against `mcp__*` wildcard
in agent tools" step.

---

# Subagents — model tiering

Each agent declares an explicit `model:` value (never `inherit`). The goal is
to pair workload with the right model class: cheap bounded tasks on `haiku`,
judgment-heavy procedures on `sonnet`. A user running `/oss` with Haiku should
not silently degrade `pr-responder`'s claim verification; a user running with
Opus should not burn tokens on `pr-compliance-checker`'s deterministic rubric.

## Current tiering

| Agent | Tier | Workload |
|-------|------|---------|
| `contribution-strategist` | `haiku` | Aggregates `status --json` into a markdown summary. Bounded scope, no judgment calls. |
| `issue-scout` | `sonnet` | Judgment on issue viability + anti-AI policy detection; reads scout-bridge output and filters. |
| `pr-compliance-checker` | `haiku` | Deterministic 6-weight rubric emission against a PR. Structured output, minimal ambiguity. |
| `pr-health-checker` | `sonnet` | Git rebase flow + CI log diagnosis; needs to reason about error messages and suggest fixes. |
| `pr-responder` | `sonnet` | Claim verification + tone calibration + multi-step draft-accuracy procedure. Heavy reasoning. |
| `pre-commit-reviewer` | `sonnet` | Five-phase diff review including security scan. Heavy reasoning. |
| `repo-evaluator` | `sonnet` | Weighs repo-health and history signals into a recommendation; needs judgment beyond bounded aggregation. |

Policy: **no agent uses `model: inherit`.** CI enforces this via the "Guard
against `model: inherit` in agent frontmatter" step. If a future agent
genuinely needs to inherit, add an inline frontmatter comment explaining why
and update the CI check to allow that specific file.

## Tuning

These defaults are placeholders informed by workload shape, not benchmarked
quality-per-dollar numbers. If a downstream regression surfaces (e.g., a
`haiku`-tier agent consistently produces low-quality output, or a `sonnet`
agent's cost makes the `/oss` flow unaffordable), bump the tier and document
the rationale in the commit.
