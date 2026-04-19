# `--json` contract golden files (#965)

Each `*.contract.test.ts` next to a command snapshots the full shape of
its `--json` output to a golden file in this directory. If a field is
added, renamed, removed, or re-typed in the command's output, the
corresponding contract test fails with a diff — preventing silent drift
in the shape that the Claude Code plugin, the MCP server, and the
dashboard all consume.

## Updating on intentional shape changes

```
# Update a single command's golden
npx vitest run -u src/commands/status.contract.test.ts

# Update all contract tests at once
npx vitest run -u src/commands/*.contract.test.ts
```

Golden updates must appear in the same PR as the shape change, so that
reviewers can see both sides of the contract at once. Any non-additive
change is a breaking change to plugin/MCP consumers — flag it in the PR
description.

## What's covered

Not every command is under contract — only the externally-consumed
ones. The roadmap lives in the tracking issue; contributions welcome.
