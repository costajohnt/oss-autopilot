# @oss-autopilot/core

CLI and core library for managing open source contributions. Track PRs, respond to maintainers, discover issues, and maintain contribution velocity.

Part of [OSS Autopilot](https://github.com/costajohnt/oss-autopilot).

## Installation

```bash
npm install -g @oss-autopilot/core
```

Or run directly:

```bash
npx @oss-autopilot/core daily --json
```

## Requirements

- Node.js 22+
- GitHub CLI (`gh`) authenticated, or `GITHUB_TOKEN` environment variable

## CLI Usage

```bash
# Daily digest of your open PRs
oss-autopilot daily --json

# Check PR status
oss-autopilot status --json

# Search for contributable issues (positional arg = max result count)
oss-autopilot search 10 --json

# Fetch PR metadata (informational only — nothing persists)
oss-autopilot track https://github.com/owner/repo/pull/123

# View help
oss-autopilot --help
```

All commands support `--json` for structured output:

```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-05-04T00:00:00.000Z"
}
```

## Library Usage

```typescript
import { PRMonitor, getStateManager } from '@oss-autopilot/core';
import { runSearch, runVet } from '@oss-autopilot/core/commands';

const token = process.env.GITHUB_TOKEN!;

// Monitor your open PRs
const monitor = new PRMonitor(token);
const result = await monitor.fetchUserOpenPRs();

// Manage state
const state = getStateManager();
const currentState = state.getState();

// Search for contributable issues (delegates to @oss-scout/core)
const searchResult = await runSearch({ maxResults: 10 });

// Vet a specific issue
const vetResult = await runVet({ issueUrl: 'https://github.com/owner/repo/issues/123' });
```

## Claude Code Plugin

For the full AI-powered experience, install as a Claude Code plugin:

```
/plugin marketplace add costajohnt/oss-autopilot
```

See the [main README](https://github.com/costajohnt/oss-autopilot) for plugin setup.

## License

MIT
