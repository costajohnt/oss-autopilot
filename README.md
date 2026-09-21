<p align="center">
  <img src="assets/hero-light.svg" alt="OSS Autopilot" width="600">
</p>

<p align="center">
  <em>Keep up with your open source pull requests. A Claude Code plugin, an MCP server, and a standalone CLI.</em>
</p>

<p align="center">
  <img src="https://github.com/costajohnt/oss-autopilot/actions/workflows/ci.yml/badge.svg" alt="CI">
  <a href="https://www.npmjs.com/package/@oss-autopilot/core"><img src="https://img.shields.io/npm/v/@oss-autopilot/core" alt="npm @oss-autopilot/core"></a>
  <a href="https://www.npmjs.com/package/@oss-autopilot/mcp"><img src="https://img.shields.io/npm/v/@oss-autopilot/mcp" alt="npm @oss-autopilot/mcp"></a>
  <img src="https://img.shields.io/node/v/@oss-autopilot/core" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code"></a>
</p>

---

If you contribute to more than a couple of projects, PRs go stale without you noticing. A maintainer asks for a change, CI breaks after a rebase, a branch picks up a conflict, and you find out two weeks later.

OSS Autopilot checks every open PR you have on GitHub and sorts them into what needs you and what is waiting on someone else. For the ones that need you, it helps draft the reply, diagnose the CI failure, or rebase the branch. You approve each push and each comment before it goes out.

![OSS Autopilot demo](docs/images/demo.gif)

## Contents

- [Requirements](#requirements)
- [Quick start (Claude Code)](#quick-start-claude-code)
- [Other ways to run it](#other-ways-to-run-it)
- [The daily check](#the-daily-check)
- [Commands](#commands)
- [Finding new issues](#finding-new-issues)
- [Overnight mode](#overnight-mode)
- [Dashboard](#dashboard)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [What it will and will not do on its own](#what-it-will-and-will-not-do-on-its-own)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Contributing](#contributing)

## Requirements

- Node.js 22 or newer
- [GitHub CLI](https://cli.github.com/) installed and logged in (`gh auth login`), or a `GITHUB_TOKEN` in your environment
- For the plugin: [Claude Code](https://claude.com/claude-code), plus `npm` and network access on first run (see below)

CI runs on Ubuntu and macOS. Windows is untested.

## Quick start (Claude Code)

```
/plugin marketplace add costajohnt/oss-autopilot
/plugin install oss-autopilot@oss-autopilot
```

Restart Claude Code, then:

```
/setup-oss
```

Setup asks for your GitHub username, the languages and labels you care about, and how many PRs you want open at once. After that, run `/oss` whenever you want to check in.

**About the first run.** The plugin ships as source. The first `/setup-oss` or `/oss` installs dependencies and builds the CLI inside the plugin directory, so it needs `npm` (or `pnpm`) and a network connection, and it takes longer than later runs. If the build fails, see [Troubleshooting](#troubleshooting).

## Other ways to run it

<details>
<summary><strong>MCP server</strong> (Cursor, Claude Desktop, Codex, Windsurf, any MCP client)</summary>

Save your GitHub username once:

```bash
npx @oss-autopilot/core@latest init <your-github-username>
```

Then add the server to your MCP client config:

```json
{
  "mcpServers": {
    "oss-autopilot": {
      "command": "npx",
      "args": ["@oss-autopilot/mcp@latest"]
    }
  }
}
```

The MCP server exposes 30 tools, 6 resources, and 4 prompts. `@latest` means you get new releases automatically; pin a version (`@oss-autopilot/mcp@5.7.4`) if you would rather update on your own schedule.

</details>

<details>
<summary><strong>Standalone CLI</strong></summary>

```bash
npx @oss-autopilot/core@latest init <your-github-username>
npx @oss-autopilot/core@latest daily          # human-readable digest
npx @oss-autopilot/core@latest daily --json   # structured output
npx @oss-autopilot/core@latest doctor         # check token, state, rate limit

# or install it
npm install -g @oss-autopilot/core
oss-autopilot --help
```

Every command accepts `--json` and returns `{ success, data, error, timestamp }`, so it is easy to script.

</details>

<details>
<summary><strong>As a library</strong></summary>

```bash
npm install @oss-autopilot/core
```

```typescript
import { runDaily, runSearch } from '@oss-autopilot/core/commands';

const digest = await runDaily();
const issues = await runSearch({ maxResults: 10 });
```

API reference: [jcosta.tech/oss-autopilot](https://jcosta.tech/oss-autopilot/).

</details>

## The daily check

<p align="center">
  <img src="docs/diagrams/daily-workflow.svg" alt="The /oss daily check: you run /oss, the CLI fetches and classifies your open PRs, the plugin shows an action menu, an agent drafts a reply or fix, you approve, and only then is anything pushed or posted" width="720">
</p>

1. Run `/oss`.
2. The CLI fetches your open PRs from GitHub and classifies each one: failing CI, changes requested, unanswered maintainer comment, merge conflict, incomplete checklist, or waiting on the maintainer.
3. You get a short list with the PRs that need you first, and a menu of actions.
4. Pick one. An agent reads the thread and the diff, then drafts a reply or prepares a fix.
5. You read the draft and approve, edit, or discard it. Nothing is pushed or posted until you approve that specific action.
6. Repeat, or stop. Most days this is a few minutes.

If you are new to this, set `maxActivePRs` to 3 to 5. A few PRs you respond to quickly do better than many you let sit.

## Commands

The plugin adds 9 slash commands:

| Command | What it does |
|---------|--------------|
| `/oss` | Daily check: what needs attention, then an action menu |
| `/oss-search` | Find issues to work on, matched to your languages and history |
| `/oss-overnight` | Unattended run that prepares fix branches locally and writes a morning report |
| `/oss-dashboard` | Open the local dashboard in your browser |
| `/oss-guidelines` | View or edit what the tool has learned about each repo's review preferences |
| `/pr-ready` | Pre-push loop: lint, tests, parallel review agents, fix, repeat until clean |
| `/plan-ready` | The same review loop for an implementation plan, before you write code |
| `/setup-oss` | Configure preferences |
| `/oss-help` | Quick reference |

**Commands:** `/oss`, `/oss-search`, `/oss-overnight`, `/oss-dashboard`, `/oss-guidelines`, `/pr-ready`, `/plan-ready`, `/setup-oss`, `/oss-help`

The plugin also ships 8 specialized agents that Claude dispatches for you:

| Agent | Job |
|-------|-----|
| `pr-responder` | Drafts replies to maintainer feedback |
| `pr-health-checker` | Diagnoses CI failures, conflicts, stale reviews; rebases when needed |
| `pr-compliance-checker` | Checks a PR against [opensource.guide](https://opensource.guide) practices and the repo's own guidelines |
| `pre-commit-reviewer` | Reviews your diff before you commit |
| `issue-scout` | Searches for and vets issues |
| `repo-evaluator` | Judges whether a repo is worth your time before you start |
| `contribution-strategist` | Looks at your history and suggests where to focus |
| `overnight-preparer` | Prepares one fix branch in a local worktree during `/oss-overnight` |

Agents exist only in the Claude Code plugin. MCP and CLI users get the same underlying data through tools and commands.

For a deeper pre-push review, install the optional `pr-review-toolkit` plugin from the Claude Code marketplace. `/pr-ready` uses its reviewers in parallel when present and falls back to the built-in `pre-commit-reviewer` when not.

## Finding new issues

`/oss-search` (or `oss-autopilot search`) looks for open issues that match your configured languages and labels, then vets each candidate: is it already claimed, is there a linked PR, does the repo merge outside contributions, how fast do maintainers respond. Search and vetting live in a separate package, [oss-scout](https://github.com/costajohnt/oss-scout).

Two documents explain the scoring so you can see why a repo did or did not show up:

- [Repo scores](docs/repo-scores.md): the history score (your own merged and closed PRs in that repo) and the health score (the repo's current activity, review speed, and merge rate).
- [Anti-LLM policy detection](docs/anti-llm-policy.md): repos whose CONTRIBUTING, CODE_OF_CONDUCT, or README say they do not accept AI-assisted contributions are skipped.

## Overnight mode

`/oss-overnight` runs the daily check unattended. For PRs with a CI failure, a conflict, or requested changes, it prepares a fix branch in a local git worktree and runs the project's tests. It writes a report to `~/.oss-autopilot/reports/`, and your next `/oss` shows it so you can decide what ships.

To schedule it on macOS:

```bash
oss-autopilot overnight schedule --install --hour 2
```

`--install` writes a launchd plist to `~/Library/LaunchAgents/` and prints the `launchctl bootstrap` command that loads it. It does not load it for you. Without `--install` it only prints the plist. There is no built-in scheduler for Linux yet; [`commands/oss-overnight.md`](commands/oss-overnight.md) describes the invocation to put in a systemd timer.

**Read this before scheduling it.** The unattended run is started with an allowlist of tools and a deny list that blocks `git push`, `gh pr comment`, `gh api`, `npm publish`, and similar commands, and it cannot ask you questions. That stops a well-behaved model from writing to GitHub. It is not a sandbox: the run executes each project's test suite with your credentials available, the same as if you ran those tests yourself. If that is more trust than you want to give, run the job as a separate OS user with no push credentials. See [`commands/oss-overnight.md`](commands/oss-overnight.md) for the full threat model.

## Dashboard

![Dashboard](https://github.com/user-attachments/assets/680ce6d6-8192-499a-b85e-f2686319b961)

`/oss-dashboard` opens a local web UI at `http://localhost:3000` with your PRs by status, contribution charts, and buttons to shelve or re-prioritize a PR. It binds to loopback only.

The dashboard currently works from the plugin install or a git checkout. The npm package does not include the dashboard assets yet, so `npx @oss-autopilot/core dashboard serve` will report that it cannot find them.

## Configuration

Settings live in `~/.oss-autopilot/state.json` under `config`. Change them with `/setup-oss`, or from the CLI:

```bash
oss-autopilot config                     # show everything
oss-autopilot config maxActivePRs 5      # set one value
```

| Setting | Default | Description |
|---------|---------|-------------|
| `githubUsername` | (detected) | Your GitHub username |
| `maxActivePRs` | 10 | Open-PR count at which the tool suggests finishing before starting more |
| `dormantDays` | 30 | Days without activity before a PR is marked dormant |
| `minStars` | 50 | Minimum repo stars to count in stats and charts |
| `languages` | (chosen at setup) | Languages for issue search |
| `labels` | (chosen at setup) | Issue labels for issue search |
| `squashByDefault` | `true` | Squash commits before merge (`true`, `false`, or `"ask"`) |
| `excludeRepos` | `[]` | Repos to leave out of everything |
| `excludeOrgs` | `[]` | Orgs to leave out of everything (for example, your employer) |
| `avoidRepos` | `[]` | Repos to rank lower in search without excluding them |
| `boostIssueTypes` | `[]` | Issue label types to rank higher in search (for example `bug`) |
| `includeDocIssues` | `true` | Include documentation issues in search |
| `autoExtractLearnings` | `true` | After a PR merges, extract what the maintainers asked for into per-repo guidelines |
| `issueListPath` | (none) | Path to your own curated issue list |
| `projectCategories` | `[]` | Categories to prioritize (nonprofit, devtools, and so on) |
| `preferredOrgs` | `[]` | Orgs to prioritize |

**Stats and badges.** `oss-autopilot stats` prints your merged-PR numbers; `--markdown` gives a shareable report and `--badge` gives shields.io endpoint JSON. For a live profile badge and SVG cards, see [oss-widgets](https://github.com/costajohnt/oss-widgets).

**Sync across machines (optional).** State can be stored in a secret GitHub gist instead of only on disk. See `oss-autopilot state --help`. A secret gist is unlisted, not access-controlled, so anyone with the URL can read it.

## How it works

<p align="center">
  <img src="docs/diagrams/architecture.svg" alt="Architecture: the Claude Code plugin, the MCP server, and the dashboard all sit on one core library and CLI, which talks to the GitHub API, delegates issue search to oss-scout, and stores state in ~/.oss-autopilot" width="820">
</p>

- **One core, three front ends.** The plugin calls the CLI with `--json`. The MCP server imports the same functions. The dashboard is served by the CLI. They share one state file.
- **The logic is code, not prompts.** PR status, CI failure categories (your bug, fork limitation, auth gate, flaky infrastructure), staleness, and repo scores are computed in TypeScript with tests. The model reads structured JSON and does the parts that need language: reading a review thread, drafting a reply, proposing a fix.
- **Nothing is cached about your PRs.** Each run fetches your open PRs fresh from GitHub's Search API and enriches them with CI status, review decisions, and conflict state. Local state holds your config, your merged and closed history, per-repo scores, and learned guidelines.
- **It is careful with the API.** ETag-based HTTP caching, rate-limit backoff, bounded concurrency, and GraphQL batching keep a daily run well inside GitHub's limits.
- **Text from GitHub is treated as untrusted.** Issue bodies, comments, and review text are fenced and labeled before an agent sees them.

More detail: [ARCHITECTURE.md](ARCHITECTURE.md). Security model and reporting: [SECURITY.md](SECURITY.md).

## What it will and will not do on its own

| | Interactive (`/oss`, MCP, CLI) | Unattended (`/oss-overnight`) |
|---|---|---|
| Read your PRs, issues, CI logs | Yes | Yes |
| Edit files in a local clone or worktree | When you pick an action | Yes, in a worktree it creates |
| Run a project's tests | When you pick an action | Yes |
| Push a branch | Only after you approve | Direct `git push` is blocked |
| Post a comment, open or merge a PR | Only after you approve | Direct `gh` writes are blocked |
| Send data anywhere other than GitHub | No | No |

In interactive use, approval is per action. Approving one reply does not approve the next one.

All data stays in `~/.oss-autopilot/` (files are written `0600`, the directory `0700`). There is no telemetry.

## Troubleshooting

Start here. It checks your token, the CLI bundle, the state file, and your rate limit:

```bash
npx @oss-autopilot/core@latest doctor
```

**`gh` is missing or not logged in**

```bash
brew install gh        # macOS; see https://cli.github.com for other platforms
gh auth login
```

**The plugin's first-run build failed**

```bash
find ~/.claude/plugins -name "oss-autopilot" -type d    # locate the plugin
cd <that path>/packages/core
npm install
npm run bundle
```

**My PRs do not show up**

- Run `/setup-oss` and confirm the GitHub username.
- Only PRs you authored are tracked.
- Check `excludeRepos`, `excludeOrgs`, and `minStars`.

**Updating**

- Plugin: `/plugin update oss-autopilot`
- MCP and CLI via `npx ...@latest`: nothing to do
- Your configuration carries over. Changelogs: [core](packages/core/CHANGELOG.md), [mcp](packages/mcp-server/CHANGELOG.md)

Found a bug? [Open an issue](https://github.com/costajohnt/oss-autopilot/issues) with the output of `doctor --json`.

## Limitations

- **GitHub only.** No GitLab, Bitbucket, or other forges.
- **1,000-result cap.** GitHub's Search API returns at most 1,000 results per query. If you have more than 1,000 open, merged, or closed PRs, the oldest are not counted.
- **Single user.** It tracks one person's PRs. No team views or shared state.
- **Dashboard is not in the npm package yet.** Plugin install or git checkout only.
- **Overnight scheduling is macOS only** out of the box.

## Contributing

Bug fixes, new agents, CLI improvements, and documentation are all welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has setup instructions.

```bash
git clone https://github.com/costajohnt/oss-autopilot.git
cd oss-autopilot
pnpm install
pnpm test
pnpm start -- daily --json      # run the CLI from source
claude --plugin-dir .           # load your checkout as the plugin
```

The diagrams in this README are generated from the JSON files in [`docs/diagrams/`](docs/diagrams/) with [archify](https://github.com/tt-a1i/archify). Regenerate them with `node docs/diagrams/export-svg.mjs`.

## About

Built and used daily by [costajohnt](https://github.com/costajohnt). The contributions below were managed with it.

<p align="center">
<a href="https://github.com/costajohnt/oss-widgets">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://oss-widgets.vercel.app/api/card/costajohnt?theme=dark&minStars=50" />
  <source media="(prefers-color-scheme: light)" srcset="https://oss-widgets.vercel.app/api/card/costajohnt?theme=light&minStars=50" />
  <img alt="OSS contribution stats for costajohnt" src="https://oss-widgets.vercel.app/api/card/costajohnt?theme=dark&minStars=50" width="495" />
</picture>
</a>
</p>

## License

MIT
