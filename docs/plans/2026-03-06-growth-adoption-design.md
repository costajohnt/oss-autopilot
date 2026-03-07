# Growth & Adoption: Zero-Config First Run + Shareable Stats

**Date:** 2026-03-06
**Status:** Approved
**Goal:** Reduce time-to-value for new users and create a viral loop that drives organic adoption without active marketing.

## Problem

OSS Autopilot has a strong core product but two adoption friction points:
1. **First-run friction** — `/setup-oss` is a required gate before users see any value
2. **No viral loop** — the product has no mechanism to passively attract new users through existing users' activity

## Solution Overview

Three features that form a self-reinforcing flywheel:

```
Zero-config first run → user retains → generates shareable stats → badge on profile
                  ↑                                                         ↓
                  └──────── new user discovers via badge ←──────────────────┘
```

## Feature 1: Zero-Config First Run

### Current Flow
```
Install plugin → /setup-oss (required) → configure username, languages, minStars → /oss → see dashboard
```

### New Flow
```
Install plugin → /oss → auto-detect username → fetch PRs → show populated dashboard
                                                         → "Run /setup-oss to customize" (optional)
```

### How It Works

1. **Auto-detect GitHub identity** — `gh auth status` gives the username. No need to ask.
2. **Immediate PR scan** — On first `/oss`, skip the config gate. Fetch all open PRs for the detected user.
3. **Smart defaults** — `minStars: 0`, no language filter, all agents enabled.
4. **No-PRs fallback** — If user has 0 open PRs, pivot to issue discovery: "No open PRs! Want to find your next contribution?"
5. **Setup becomes optional** — `/setup-oss` is reframed as "customize" not "required."

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| `gh` not installed | Friendly install instructions with link |
| `gh` not authenticated | "Run `gh auth login` — takes 30 seconds" |
| 0 open PRs | Pivot to issue discovery |
| 100+ open PRs | Top 10 by urgency, mention filters |
| Rate limited | Partial results with retry guidance |
| Config already exists | Use existing config (no regression) |

### Changes

- `commands/oss.md` — add auto-detect logic before config check
- `packages/core/src/commands/daily.ts` — accept `--auto-detect` flag, initialize defaults
- `packages/core/src/core/state.ts` — add `initializeWithDefaults(username)` method
- `commands/setup-oss.md` — reframe as optional customization

## Feature 2: Contribution Stats Command

### New CLI Command: `oss-autopilot stats`

**Output modes:**
- Default — formatted terminal output
- `--json` — structured stats data
- `--markdown` — shareable markdown report
- `--badge` — shields.io-compatible JSON

**Stats computed:**
- Active PR count
- Merge rate (merged / (merged + closed))
- Total repos contributed to
- Top repos by merged PR count
- Contribution streak (consecutive days with PR activity)
- Total merged / closed / open counts

### New Files

- `packages/core/src/commands/stats.ts` — CLI subcommand
- `packages/core/src/core/stats.ts` — stats computation logic
- `packages/core/src/core/stats.test.ts` — tests
- `commands/oss-stats.md` — plugin slash command (optional)

## Feature 3: Shields.io Badge Endpoint

### Architecture

Tiny serverless function (Vercel or Cloudflare Workers):
- Single route: `GET /api/badge/:username`
- Queries GitHub Search API, computes stats, returns shields.io JSON
- 1-hour cache with stale-while-revalidate
- Lives in `packages/badge-endpoint/` (new monorepo package)

### Usage

```markdown
![OSS Contributions](https://img.shields.io/endpoint?url=https://oss-autopilot-stats.vercel.app/api/badge/johncosta)
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| New contributor (0 merged) | "Getting Started" badge with encouraging message |
| Private repos | Public contributions only (GitHub Search API limitation). Documented. |
| Rate limits | Return stale cached data |
| Unknown username | "user not found" badge, not 500 |

### New Files

- `packages/badge-endpoint/` — new monorepo package
- `packages/badge-endpoint/api/badge/[username].ts` — route handler
- Shares stats computation logic from `packages/core/src/core/stats.ts`

## Implementation Priority

1. **Zero-config first run** — highest impact, lowest effort
2. **Stats command** — foundation for badges, standalone value
3. **Badge endpoint** — viral loop, depends on stats logic

## Migration

No breaking changes. Purely additive:
- Existing users with config work exactly as before
- `stats` command is opt-in
- First-run auto-detect only triggers when no config exists

## Success Metrics

- Time from install to first dashboard view (target: <30 seconds, currently requires manual setup)
- Badge adoption (number of users embedding badges)
- Organic installs (no marketing — tracked via npm/plugin install counts)
