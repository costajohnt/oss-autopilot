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
| `mcp__plugin_oss-autopilot_oss-autopilot__move`, `__track`, `__dismiss`, `__shelve` (and their inverses) | Mutate `~/.oss-autopilot/state.json`. Agents that need to influence state should produce a recommendation for the parent workflow to act on, not mutate directly. |
| `mcp__linkedin__*`, `mcp__claude_ai_Gmail__*`, `mcp__puppeteer__*`, `mcp__plugin_serena_serena__execute_shell_command` | Out of scope — OSS Autopilot agents should never need cross-channel messaging, arbitrary web control, or sandbox escape. |

## Per-agent allowlists

- `contribution-strategist` — `Bash`, `Read` (read-only analyzer; emits a markdown report in chat).
- `issue-scout` — `Bash`, `Read`, `mcp__...__search`, `mcp__...__vet`, `mcp__...__vet-list`.
- `pr-compliance-checker` — `Bash`, `Read`, `Glob`, `Grep`, `mcp__...__read`, `mcp__...__comments`.
- `pr-health-checker` — `Bash`, `Read`, `Grep`, `mcp__...__read`, `mcp__...__comments`.
- `pr-responder` — `Bash`, `Read`, `Write`, `Glob`, `Grep`, `mcp__...__read`, `mcp__...__comments` (keeps `Write` for drafting response files under `/tmp`; posting still routes through `draft-review-post`).
- `pre-commit-reviewer` — `Bash`, `Read`, `Glob`, `Grep` (local git/diff review only).
- `repo-evaluator` — `Bash`, `Read`, `Glob`, `mcp__...__vet`.

## Adding a tool

When a new agent genuinely needs a tool not listed above, add it explicitly —
never use `mcp__*`. CI enforces this via the "Guard against `mcp__*` wildcard
in agent tools" step.
