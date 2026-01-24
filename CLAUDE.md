# Claude Code Instructions

## Git Workflow

1. **Always pull from main first**: `git pull origin main`
2. **Create a feature branch**: `git checkout -b feature/your-feature-name`
3. **Make changes and commit** to the feature branch
4. **Push the branch**: `git push -u origin feature/your-feature-name`
5. **Open a PR** against main using `gh pr create`

### Before Merging a PR

When ready to merge, always squash commits and update the PR:

1. **Squash commits**: `git rebase -i main` and squash all commits into one
2. **Write a detailed commit message** that describes ALL work done:
   - Use conventional commit format (feat:, fix:, refactor:, etc.)
   - Include a summary paragraph explaining the overall change
   - List key changes as bullet points
3. **Force push**: `git push --force-with-lease`
4. **Update PR title and description** to match the squashed commit message

**Important:**
- Do NOT merge PRs - the maintainer will handle merging
- Do NOT push directly to main
- Keep PRs focused and atomic

**AI Attribution Rule (CRITICAL):**
NEVER add AI attribution to commits, comments, or PRs unless the repository explicitly requires disclosure of AI tool usage. This includes:
- No "Co-Authored-By: Claude" or similar in commit messages
- No "Generated with Claude Code" or similar in PR descriptions
- No AI mentions in comments or responses
- Contributions should appear as solely from the user

## Project Overview

oss-autopilot is a Claude Code plugin for managing open source contributions. It provides slash commands, specialized agents, and skills for tracking PRs, responding to maintainers, and discovering new issues.

## Plugin Structure

```
.claude-plugin/
└── plugin.json          # Plugin manifest

commands/
├── oss.md               # /oss - Daily check command
└── setup-oss.md         # /setup-oss - Configuration wizard

agents/
├── pr-responder.md      # Drafts responses to maintainer feedback
├── pr-health-checker.md # Diagnoses CI failures, conflicts
├── pr-compliance-checker.md # Validates PRs against opensource.guide
├── issue-scout.md       # Finds and vets new issues
├── repo-evaluator.md    # Analyzes repository health
└── contribution-strategist.md # Strategic OSS advice

skills/
└── oss-contribution/
    └── SKILL.md         # OSS best practices

.claude/oss-autopilot/   # Runtime state (gitignored)
├── config.md            # User preferences
├── tracked-prs.md       # Active PRs
├── pr-history.md        # Merged/closed PRs
└── repo-scores.md       # Repository evaluations
```

## Development Notes

- This is a markdown-based plugin - no compilation needed
- Test changes by running `/oss` or `/setup-oss` in Claude Code
- State files use YAML frontmatter + markdown tables
- All agents should include `AskUserQuestion` for human-in-the-loop
