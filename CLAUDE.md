# Claude Code Instructions

## Git Workflow

1. **Always pull from main first**: `git pull origin main`
2. **Create a feature branch**: `git checkout -b feature/your-feature-name`
3. **Make changes and commit** to the feature branch
4. **Push the branch**: `git push -u origin feature/your-feature-name`
5. **Open a PR** against main using `gh pr create`

**Important:**
- Do NOT merge PRs - the maintainer will handle merging
- Do NOT push directly to main
- Keep PRs focused and atomic

## Project Overview

oss-autopilot is a CLI tool for managing open source contributions, designed to integrate with Claude Code via slash commands.

## Key Commands

```bash
npm run build          # Compile TypeScript
npm test               # Run tests
npm start -- <cmd>     # Run CLI commands
```

## File Structure

- `src/index.ts` - CLI entry point and commands
- `src/state.ts` - State management (JSON persistence)
- `src/pr-monitor.ts` - PR tracking and status checks
- `src/issue-discovery.ts` - Issue search and vetting
- `examples/*.md` - Slash command definitions
- `data/state.json` - Persisted state (gitignored)
