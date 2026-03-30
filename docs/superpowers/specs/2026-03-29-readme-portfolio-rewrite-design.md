# README Portfolio Rewrite — Design Spec

## Context

OSS Autopilot has grown into a feature-rich framework (912+ issues/PRs, 72 releases, 1,762 tests) but struggles with marketing and discoverability (8 GitHub stars). After analysis, we concluded:

- The addressable market for "OSS contribution management" is very small
- The marketing paradox: the best pitch ("I used AI to merge 80 PRs") undermines the contributions themselves
- No additional modules are worth extracting beyond oss-scout (already done)
- The README should be repositioned as a **portfolio showcase** for employers/clients, not a product page for users

## Goals

1. Reposition oss-autopilot's README as a portfolio piece that demonstrates engineering depth and real-world results
2. Keep it functional as a product page for the rare user who wants to install it
3. Shift marketing energy to oss-scout (broader market, no attribution paradox)

## Target Audience

Primary: **Hiring managers and technical leads** scanning the GitHub profile.
Secondary: Developers who discover the tool and want to use it.

## README Structure

### Section 1: Hero + Credentials

**Purpose:** First 10 seconds — establish credibility before the employer decides to scroll.

- Hero image (keep existing SVG)
- One-liner: "An AI-powered workflow engine for managing open source contributions at scale — built as a Claude Code plugin, MCP server, and standalone CLI."
- Credentials block:
  - "3rd biggest contributor to Ink — the React CLI framework behind Claude Code, Gemini CLI, and Codex (32k+ stars)"
  - "Repeat contributor to Homebrew"
  - oss-widgets cards embedded showing live contribution stats
- CI/npm badges move down to the install section

### Section 2: What This Project Is

**Purpose:** Brief context — 3-4 sentences max, not a feature tour.

- What it does in plain language (monitors PRs, alerts on feedback, helps respond, finds new issues)
- What it's built as (Claude Code plugin + CLI + MCP server + dashboard)
- Demo GIF or screenshot

### Section 3: Engineering Highlights

**Purpose:** The centerpiece. Shows architecture decisions and engineering maturity.

- Architecture diagram (keep existing ASCII box diagram)
- 9 highlights, each 2-3 sentences:

1. **Monorepo with three npm packages** — pnpm workspaces, each independently publishable to npm. Core library, MCP server, and interactive dashboard with shared types.

2. **Three deployment models** — Claude Code plugin (agents + workflows), MCP server (Cursor/Claude Desktop/Codex/Windsurf), standalone CLI with `--json` structured output. Same core, different interfaces.

3. **Modular extraction** — Issue discovery grew complex enough to extract into its own package (oss-scout). Connected via a bridge pattern that maps state between the two systems.

4. **Fresh-fetch architecture** — PRs aren't stored locally. Every run fetches live from GitHub's Search API and enriches with CI status, review decisions, conflict detection, and maintainer comment classification. No stale data.

5. **Production-grade GitHub API integration** — ETag-based HTTP caching, automatic rate limit backoff with retries, bounded concurrency pools, paginated fetching. Designed to run daily without hitting API limits.

6. **Human-in-the-loop guardrails** — Nothing is posted to GitHub without explicit approval. AI drafts responses but the contributor always reviews before sending. Pre-commit review gates catch issues before they reach maintainers.

7. **Deterministic core, AI orchestration layer** — Critical logic (status classification, CI analysis, state management) lives in tested TypeScript, not in prompts. The CLI returns structured JSON that agents consume. Evolution from LLM-based classification to deterministic taxonomy (e.g., CI failures categorized as actionable/fork_limitation/auth_gate/infrastructure). 1,762 tests validate the core independently of any LLM.

8. **Security discipline** — State files written with 0o600 permissions, data directory with 0o700. Concurrent state write protection. Runtime schema validation via Zod. XSS prevention tested. Input validation hardened across CLI arguments and API responses.

9. **Automated release pipeline** — Conventional commits, release-please for versioning and changelogs, CI/CD for npm publishing. 72 releases from v0.1.0 to v1.11.0 in under 3 months.

**Narrative threads woven into surrounding text (not separate bullets):**
- Fork workflow expertise (correct diff ranges, squash counting, --head flag handling) as domain credibility
- UX iteration driven by dogfooding (capacity warnings, diminishing returns detection, "skip comment when code speaks for itself") as the development story

### Section 4: Install & Usage (compressed)

**Purpose:** Prove it's a real, working tool without dominating the page.

- All three deployment models in compact format (collapsible or tabbed)
  - Plugin: 3-line install
  - MCP: config JSON snippet
  - CLI: one-liner
- Brief usage section (daily workflow in 3 steps)
- Link to full docs for details

### Section 5: By the Numbers

**Purpose:** Quick-scan stats block that catches an employer's eye.

- 912+ issues/PRs across the project
- 72 releases (v0.1.0 → v1.11.0) since January 2026
- 1,762 tests across 62 test files
- 512 commits in ~3 months
- oss-widgets embedded for live contribution stats (auto-updating)

### Section 6: Everything Else (collapsed)

**Purpose:** Reference material for actual users. Doesn't compete with the portfolio narrative.

All in collapsible `<details>` blocks:
- Configuration table
- Specialized agents table
- FAQ & Troubleshooting
- Development setup
- Contributing
- Limitations

## What Changes vs Current README

| Current | New |
|---------|-----|
| Opens with relatable user scenario | Opens with credentials (Ink, Homebrew) |
| CI/npm badges in hero | Badges move to install section |
| Long "What It Does" with feature tour | Brief 3-4 sentence summary |
| No engineering section | Engineering Highlights as centerpiece |
| Install instructions prominent | Install compressed/collapsible |
| No stats/numbers section | "By the Numbers" quick-scan block |
| Config/FAQ/troubleshooting inline | All collapsed into `<details>` |
| Agents table prominent | Agents table collapsed |
| Contribution stats/badges section prominent | Replaced by oss-widgets in hero |

## What Stays the Same

- Hero SVG image
- Architecture ASCII diagram
- Demo GIF
- All install instructions (just repositioned)
- All configuration/FAQ/troubleshooting content (just collapsed)
- License, contributing link

## Out of Scope

- Changes to oss-scout README (separate effort)
- New marketing channels or blog posts
- Changes to the actual codebase or CLI
- oss-widgets changes
