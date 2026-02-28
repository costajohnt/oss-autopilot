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

- Node.js 20+
- GitHub CLI (`gh`) authenticated, or `GITHUB_TOKEN` environment variable

## CLI Usage

```bash
# Daily digest of your open PRs
oss-autopilot daily --json

# Check PR status
oss-autopilot status --json

# Search for contributable issues
oss-autopilot search "react" --json

# Track a new PR
oss-autopilot track https://github.com/owner/repo/pull/123

# View help
oss-autopilot --help
```

All commands support `--json` for structured output:

```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-02-28T12:00:00.000Z"
}
```

## Library Usage

```typescript
import { PRMonitor, StateManager, IssueDiscovery } from '@oss-autopilot/core';

// Monitor your open PRs
const monitor = new PRMonitor();
const result = await monitor.fetchAllPRs('your-github-username');

// Manage state
const state = StateManager.getInstance();
const currentState = await state.load();

// Discover contributable issues
const discovery = new IssueDiscovery();
const issues = await discovery.searchIssues({ query: 'good first issue' });
```

## Claude Code Plugin

For the full AI-powered experience, install as a Claude Code plugin:

```
/plugin marketplace add costajohnt/oss-autopilot
```

See the [main README](https://github.com/costajohnt/oss-autopilot) for plugin setup.

## License

MIT
