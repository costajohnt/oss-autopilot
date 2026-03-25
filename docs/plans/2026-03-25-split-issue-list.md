# Split Issue List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the curated issue list into an actionable file (dashboard-worthy) and a minimal skip file (dedup registry with 90-day TTL auto-culling). Prevent the skip list from growing unboundedly.

**Architecture:** Option A — plugin-layer primary. The skip file is a flat text file (`date URL` per line), not structured markdown. The core TypeScript layer gets one small addition: a `skippedIssuesPath` config field in the state schema. All skip-file reading/writing/culling is done by the plugin layer via bash commands (grep, date comparison). The `parse-list` CLI command and dashboard continue reading only the actionable file — no changes needed there.

**Tech Stack:** TypeScript (state schema only), plugin markdown, bash

---

## Skip File Format

```
# Skipped Issues — auto-culled after 90 days
# Format: YYYY-MM-DD URL

2026-03-25 https://github.com/owner/repo/issues/123
2026-03-25 https://github.com/owner/repo/issues/456
2026-02-15 https://github.com/other/repo/issues/789
```

- One line per entry: ISO date + space + full GitHub issue URL
- Lines starting with `#` are comments (ignored)
- Auto-culled: entries older than 90 days are removed on each search run
- No structured parsing needed — `grep` for dedup, `awk`/`date` for culling

---

## File Map

| File | Action | What Changes |
|------|--------|-------------|
| `packages/core/src/core/state-schema.ts` | Modify | Add `skippedIssuesPath` optional string to config schema |
| `packages/core/src/core/state-schema.test.ts` or `state.test.ts` | Modify | Test that new field round-trips through schema |
| `packages/core/src/commands/startup.ts` | Modify | Detect skip file alongside issue list, report path in startup output |
| `packages/core/src/formatters/json.ts` | Modify | Add `skippedIssuesPath` to `IssueListInfo` type |
| `commands/oss-search.md` | Modify | Vet flow writes skipped items to skip file; dedup checks both files; auto-cull on each run |
| `commands/setup-oss.md` | Modify | Add skip file path configuration option |
| ~~`workflows/issue-curation-cron.md`~~ | ~~Modify~~ | ~~Curation also culls the skip file~~ — **Removed: cron automation was deleted in issue 874** |

---

### Task 1: Add `skippedIssuesPath` to state schema

**Files:**
- Modify: `packages/core/src/core/state-schema.ts`
- Test: `packages/core/src/core/state.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `state.test.ts` inside the "Configuration" describe block:

```typescript
it('should store and retrieve skippedIssuesPath', () => {
  const sm = new StateManager(true);
  sm.updateConfig({ skippedIssuesPath: '/path/to/skipped-issues.md' });
  expect(sm.getState().config.skippedIssuesPath).toBe('/path/to/skipped-issues.md');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/state.test.ts -t "skippedIssuesPath"`
Expected: FAIL (property doesn't exist on config type)

- [ ] **Step 3: Add field to schema**

In `state-schema.ts`, find the config schema object (where `issueListPath` is defined, around line 195). Add below it:

```typescript
skippedIssuesPath: z.string().optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/state.test.ts -t "skippedIssuesPath"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (the new field is optional, so no existing tests break).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/state-schema.ts packages/core/src/core/state.test.ts
git commit -m "feat: add skippedIssuesPath config field to state schema"
```

---

### Task 2: Detect skip file in startup and report in output

**Files:**
- Modify: `packages/core/src/commands/startup.ts` (the `detectIssueList` function)
- Modify: `packages/core/src/formatters/json.ts` (the `IssueListInfo` type)
- Test: `packages/core/src/commands/startup.test.ts`

- [ ] **Step 1: Add `skippedIssuesPath` to `IssueListInfo`**

In `formatters/json.ts`, find the `IssueListInfo` interface and add:

```typescript
skippedIssuesPath?: string;
```

- [ ] **Step 2: Detect skip file in `detectIssueList`**

In `startup.ts`, in the `detectIssueList` function, after the issue list is found, also look for the skip file:

```typescript
// 5. Detect skipped issues file
let skippedIssuesPath: string | undefined;

// Check config first
try {
  const stateManager = getStateManager();
  const configuredSkipPath = stateManager.getState().config.skippedIssuesPath;
  if (configuredSkipPath && fs.existsSync(configuredSkipPath)) {
    skippedIssuesPath = configuredSkipPath;
  }
} catch { /* fall through */ }

// Probe default path: same directory as issue list, named skipped-issues.md
if (!skippedIssuesPath && issueListPath) {
  const defaultSkipPath = path.join(path.dirname(issueListPath), 'skipped-issues.md');
  if (fs.existsSync(defaultSkipPath)) {
    skippedIssuesPath = defaultSkipPath;
  }
}
```

Include `skippedIssuesPath` in the returned `IssueListInfo` object.

- [ ] **Step 3: Add test**

In `startup.test.ts`, add a test that verifies `skippedIssuesPath` is returned when the file exists alongside the issue list. Use the existing test patterns (mock fs, create temp files).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/commands/startup.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/commands/startup.ts packages/core/src/formatters/json.ts packages/core/src/commands/startup.test.ts
git commit -m "feat: detect skipped issues file in startup and report path"
```

---

### Task 3: Update oss-search vet flow to write skipped items to skip file

**Files:**
- Modify: `commands/oss-search.md`

This is the main behavioral change. Three modifications to the vet flow:

- [ ] **Step 1: Add skip file auto-cull at the start of each search**

After the "Parallel Multi-Strategy Search" heading but before dispatching strategies, add a cull step:

```markdown
### Pre-Search: Cull Skip File

If a skipped issues file exists (check `skippedIssuesPath` from startup data, or probe `skipped-issues.md` in the same directory as the issue list), auto-cull entries older than 90 days:

\`\`\`bash
SKIP_FILE="{skippedIssuesPath or default probe path}"
if [ -f "$SKIP_FILE" ]; then
  CUTOFF=$(date -v-90d +%Y-%m-%d 2>/dev/null || date -d '90 days ago' +%Y-%m-%d)
  # Keep comments and entries newer than cutoff
  awk -v cutoff="$CUTOFF" '/^#/ || /^$/ { print; next } $1 >= cutoff { print }' "$SKIP_FILE" > "${SKIP_FILE}.tmp" && mv "${SKIP_FILE}.tmp" "$SKIP_FILE"
  CULLED=$(diff <(wc -l < "$SKIP_FILE") <(echo) 2>/dev/null)
fi
\`\`\`

If entries were culled, log: "Culled {N} expired entries from skip list (>90 days old)."
```

- [ ] **Step 2: Add skip file to dedup step**

In the "Combine, Filter, and Deduplicate" section, after step 2 ("Filter Strategy B against `searchedRepos`"), add:

```markdown
2b. **Skip file dedup** — if skip file exists, read all URLs from it:
\`\`\`bash
SKIP_URLS=$(grep -v '^#' "$SKIP_FILE" 2>/dev/null | awk '{print $2}')
\`\`\`
Remove any candidate whose URL appears in `SKIP_URLS`.
```

- [ ] **Step 3: Update vet result routing**

In the "Batch Vet Flow" section, after step 3 (Score Threshold Filter), change the routing for below-threshold items:

Currently: items below threshold are just filtered and listed.

Change to: items below threshold are **appended to the skip file** with today's date:

```markdown
For each filtered (below-threshold) item, append to the skip file:
\`\`\`bash
echo "$(date +%Y-%m-%d) {issue_url}" >> "$SKIP_FILE"
\`\`\`

If the skip file doesn't exist yet, create it with a header:
\`\`\`bash
if [ ! -f "$SKIP_FILE" ]; then
  echo "# Skipped Issues — auto-culled after 90 days" > "$SKIP_FILE"
  echo "# Format: YYYY-MM-DD URL" >> "$SKIP_FILE"
  echo "" >> "$SKIP_FILE"
fi
\`\`\`
```

Also: when a user explicitly selects "Skip" for an issue (in the "Pick one to vet now" flow), append it to the skip file with the same format.

- [ ] **Step 4: Commit**

```bash
git add commands/oss-search.md
git commit -m "feat: write skipped issues to separate dedup file with 90-day TTL"
```

---

### Task 4: Update setup-oss to allow configuring skip file path

**Files:**
- Modify: `commands/setup-oss.md`

- [ ] **Step 1: Add skip file path option**

Find the section where `issueListPath` is configured. Add a follow-up question:

```markdown
If the user configures an issue list path, also ask:

"Where should skipped/rejected issues be tracked? This is a dedup file — prevents re-surfacing issues you've already vetted and rejected. Entries auto-expire after 90 days."

Default: same directory as the issue list, named `skipped-issues.md`.

Options:
1. "Use default ({directory}/skipped-issues.md)" — "Same folder as your issue list"
2. "Custom path" — "Specify a different location"
3. "Skip" — "Don't track skipped issues (may see duplicates in search)"
```

Save the chosen path via:
```bash
GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" config --set skippedIssuesPath="{path}" --json
```

- [ ] **Step 2: Commit**

```bash
git add commands/setup-oss.md
git commit -m "feat: add skipped issues path configuration to setup wizard"
```

---

### Task 5: ~~Update issue curation cron to cull skip file~~ — SKIPPED

**Superseded by issue 874:** Cron automation was removed entirely. The skip file culling logic could be relocated to `commands/oss-search.md` as a future enhancement if desired.

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 2: Run lint**

Run: `pnpm run lint`
Expected: No new errors.

- [ ] **Step 3: Build bundle**

Run: `pnpm run bundle`
Expected: Bundle builds successfully.

- [ ] **Step 4: Verify skip file format works end-to-end**

Create a test skip file and verify the cull logic:
```bash
cat > /tmp/test-skip.md << 'EOF'
# Skipped Issues — auto-culled after 90 days
# Format: YYYY-MM-DD URL

2025-12-01 https://github.com/old/repo/issues/1
2026-03-20 https://github.com/recent/repo/issues/2
2026-03-25 https://github.com/today/repo/issues/3
EOF

CUTOFF=$(date -v-90d +%Y-%m-%d 2>/dev/null || date -d '90 days ago' +%Y-%m-%d)
awk -v cutoff="$CUTOFF" '/^#/ || /^$/ { print; next } $1 >= cutoff { print }' /tmp/test-skip.md
```

Expected: the 2025-12-01 entry is removed, the other two remain.
