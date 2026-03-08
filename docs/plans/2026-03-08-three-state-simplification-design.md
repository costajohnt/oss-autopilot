# Three-State PR Simplification — Design

## Problem

The current PR management has too many overlapping concepts:
- **Shelve/Unshelve** — hide a PR from daily digest
- **Status Override** — manually flip between needs_addressing ↔ waiting_on_maintainer
- **Snooze/Unsnooze** — time-based suppression of CI failure notifications
- **Dismiss (PRs)** — mute PR notifications until new activity
- **Dismiss (Issues)** — mark issue responses as read

These overlap in confusing ways. Snooze only affects CI failures. Dismiss and shelve both hide PRs. Override is the only way to correct a misclassified status but uses different terminology from shelve.

## Design

### Three PR States

Every PR is in exactly one of three states:

| State | Meaning |
|-------|---------|
| **Need Attention** | `status === 'needs_addressing'` — contributor action required |
| **Waiting on Maintainer** | `status === 'waiting_on_maintainer'` — nothing to do right now |
| **Shelved** | Manually hidden — excluded from capacity and actionable items |

The system computes Need Attention vs Waiting on Maintainer automatically. Users can override with `move`.

### Unified `move` Command

A single command to transition PRs between states:

```
oss-autopilot move <pr-url> <target>
```

Targets:
- `attention` — force to Need Attention (sets status override to `needs_addressing`)
- `waiting` — force to Waiting on Maintainer (sets status override to `waiting_on_maintainer`)
- `shelved` — shelve the PR (calls `shelvePR()`)
- `auto` — clear all manual overrides, return to computed status (clears override + unshelves)

Implementation:
- `move url attention` → `setStatusOverride(url, 'needs_addressing', ...)` + `unshelvePR(url)`
- `move url waiting` → `setStatusOverride(url, 'waiting_on_maintainer', ...)` + `unshelvePR(url)`
- `move url shelved` → `shelvePR(url)` + `clearStatusOverride(url)`
- `move url auto` → `clearStatusOverride(url)` + `unshelvePR(url)`

### What Gets Removed

1. **Snooze** — entire feature removed (types, state methods, commands, CLI registration, MCP tools, daily logic, tests)
2. **PR Dismiss** — removed. Only issue dismiss remains (mark-as-read semantics with auto-undismiss on new activity)
3. **`override` / `clear-override` CLI commands** — replaced by `move`. Kept as hidden aliases for backward compatibility during transition.
4. **`shelve` / `unshelve` CLI commands** — kept as aliases for `move url shelved` / `move url auto`

### What Gets Kept

1. **Issue dismiss** — unchanged. `dismiss <issue-url>` marks an issue response as read. Auto-undismisses when new responses arrive.
2. **Auto-unshelve** — shelved PRs with `needs_addressing` status auto-unshelve on daily check. This is desired behavior.
3. **Status override auto-clear** — overrides auto-clear when PR has new GitHub activity. Unchanged.
4. **All internal state methods** — `shelvePR()`, `unshelvePR()`, `setStatusOverride()`, `clearStatusOverride()` remain. The `move` command composes them.

### State Migration

On `loadState()`:
- Strip `snoozedPRs` from config (dead data after snooze removal)
- Strip PR URLs from `dismissedIssues` (URLs matching `/pull/\d+` pattern — they'll never auto-undismiss since PR dismiss filtering is removed)

No version bump needed — this is additive cleanup during load, not a schema change.

### CLI Changes

| Before | After |
|--------|-------|
| `shelve <url>` | Alias → `move <url> shelved` |
| `unshelve <url>` | Alias → `move <url> auto` |
| `override <url> <status>` | Hidden alias → `move <url> attention\|waiting` |
| `clear-override <url>` | Hidden alias → `move <url> auto` |
| `snooze <url> --reason ...` | **Removed** |
| `unsnooze <url>` | **Removed** |
| `dismiss <url>` (PR) | **Removed** (issues only) |
| `dismiss <url>` (issue) | Unchanged |
| — | **New**: `move <url> <target>` |

### Dashboard Changes

- `override_status` action → becomes `move` action with target `attention` or `waiting`
- Shelve/Unshelve buttons → send `move` action with target `shelved` or `auto`
- Remove any snooze UI references
- ActionType union: `'shelve' | 'unshelve' | 'override_status' | 'dismiss_issue_response'` → `'move' | 'dismiss_issue_response'`

### MCP Server Changes

**Breaking change — major version bump to v2.0.0.**

Remove tools: `snooze`, `unsnooze`
Add tool: `move` (with `prUrl` and `target` parameters)
Keep tools: `dismiss` (restrict description to issues), `undismiss` (restrict description to issues), `shelve` (alias for move shelved), `unshelve` (alias for move auto)

Update resource descriptions to remove snooze references.

### Dismiss Command Changes

`dismiss` and `undismiss` commands:
- CLI: Validate URL is an issue URL (reject `/pull/` URLs with helpful error message pointing to `move`)
- MCP: Update descriptions to say "issue" not "issue or PR"
- Dashboard: `dismiss_issue_response` action unchanged (already issue-only in UI)

### `collectActionableIssues` Signature Change

Remove `snoozedUrls: Set<string>` parameter. The function currently uses it to skip `failing_ci` items for snoozed PRs. With snooze removed, this filtering disappears.

Before: `collectActionableIssues(prs, snoozedUrls, lastDigestAt)`
After: `collectActionableIssues(prs, lastDigestAt)`
