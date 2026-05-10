# Draft-First Workflow (New Contributions)

> **Session state:** Expects `isNewContribution === true`, `issueContext = { title, url, description }`.
> **Produces:** `prNumber`, `prUrl`, `baseBranch`, `roundNumber`.
> **Returns to:** Core router (`commands/oss.md`) for "After Each Action" and "Session End".
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

## Step 1: Pre-flight Checks

### 1a. Verify Changes Exist

```bash
git status --porcelain
```

**If output is empty:** Report no changes and return to the core router (`commands/oss.md`).

### 1b. Branch Base Validation

Verify the current branch is based on the latest upstream default. This is a safety net for cases where the branch was created outside the Branch Setup Protocol.

```bash
upstreamRepo=$(echo "{issueContext.url}" | sed -n 's|https://github.com/\([^/]*/[^/]*\)/.*|\1|p')
upstreamDefault=$(gh repo view "$upstreamRepo" --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null)

# Determine remote
remote="upstream"
git remote get-url upstream 2>/dev/null || remote="origin"
git fetch "$remote" "$upstreamDefault" 2>/dev/null

mergeBase=$(git merge-base "$remote/$upstreamDefault" HEAD 2>/dev/null)
upstreamHead=$(git rev-parse "$remote/$upstreamDefault" 2>/dev/null)
```

**If `$mergeBase` != `$upstreamHead`** (branch is behind upstream):

```bash
behindCount=$(git rev-list --count "$mergeBase".."$remote/$upstreamDefault" 2>/dev/null || echo "unknown")
```

- **1–20 commits behind:** Note: "Your branch is {behindCount} commit(s) behind `{remote}/{upstreamDefault}`. This is normal during active development."
- **>20 commits behind:** Warn: "Your branch is {behindCount} commits behind `{remote}/{upstreamDefault}`. Consider rebasing to reduce merge conflict risk."

Offer (for any non-zero behind count):
1. "Rebase onto upstream (Recommended)" — `git rebase $remote/$upstreamDefault`. If the rebase fails (merge conflicts, dirty worktree), report the error and offer: "Abort rebase and proceed with current base" (`git rebase --abort`) / "I'll resolve conflicts manually" (pause workflow) / "Done for now".
2. "Proceed anyway" — "I know the base is correct"

**If validation commands fail** (no network, gh CLI error): Note "Could not verify branch base — proceeding." Continue to Step 1c.

**If branch is up to date:** Proceed to Step 1c.

If validation succeeded, store in session context: `upstreamDefault` (the default branch name) and `upstreamRemote` (either `"upstream"` or `"origin"`). These are reused in Step 3 for computing `baseBranch`. If validation failed, do NOT store these values — Step 3 will detect the base branch independently.

### 1c. Node.js Version Compatibility Check

Before writing code, verify the local Node.js version is compatible with the target repo.

```bash
# Check repo requirements (in order of precedence), then local version
cat .nvmrc 2>/dev/null || cat .node-version 2>/dev/null || node -e "const p=require('./package.json'); console.log(p.engines?.node || 'none')"
node --version
# Check for version managers (only needed if incompatible)
command -v nvm 2>/dev/null || command -v fnm 2>/dev/null || command -v volta 2>/dev/null || echo "no version manager found"
```

**If the repo specifies a version requirement and the local version is incompatible:**
> "This repo requires Node {required} but you have Node {local}. Tests may not run locally."

Offer:
1. "Switch Node version" — run `nvm use` / `fnm use` / `volta run` as appropriate
2. "Proceed anyway" — "I'll handle version issues later"
3. "Skip this issue" — "Pick a different one"

**If no version requirement found or versions are compatible:** Proceed to Step 1d.

### 1d. CONTRIBUTING.md Compliance Check

Before committing, verify the changes satisfy the target repo's contribution requirements. This checks repo-specific requirements (tests, docs, changelog, etc.); Step 9's compliance check covers general open-source best practices via the `pr-compliance-checker` agent.

#### 1. Search for contribution guidelines

Look for these files in order (stop at the first one found):

```
CONTRIBUTING.md
.github/CONTRIBUTING.md
docs/CONTRIBUTING.md
HACKING.md
docs/HACKING.md
DEVELOPMENT.md
docs/DEVELOPMENT.md
```

**If no guidelines file found:** Note "No CONTRIBUTING.md found — skipping compliance check." and proceed to Step 1e.

**If a file is found but cannot be read** (permission error, encoding issue, excessively large): Note "Found {path} but could not read it: {reason}. Skipping compliance check." and proceed to Step 1e.

Store the file content in session context as `contributingGuidelines` for reuse in later steps (PR body generation in Step 8, review context in Step 3).

#### 2. Extract actionable requirements

Read the file and extract a checklist of **actionable requirements** — things a contributor must do before submitting a PR. Typical categories:

| Category | Examples |
|----------|----------|
| **Tests** | "Add tests for new functionality", "Ensure all tests pass" |
| **Documentation** | "Update the user manual", "Add JSDoc comments", "Update README" |
| **Changelog** | "Add a CHANGELOG entry", "Update CHANGES.md" |
| **Code style** | "Run `cargo fmt`", "Run `npm run lint`", "Follow the style guide" |
| **Commit format** | "Use conventional commits", "Sign your commits" |
| **CLA/DCO** | "Sign the CLA", "Add a Signed-off-by line" |
| **Branch** | "Branch from `develop`", "Target the `next` branch" |
| **Scope** | "One feature per PR", "Keep PRs small" |

Ignore vague guidance (e.g., "be respectful") and focus on concrete, verifiable items.

#### 3. Verify compliance

For each extracted requirement, check whether the current changes satisfy it:

- **Tests:** Are there new/updated test files in the diff? If the requirement says "ensure tests pass", run the project's test command (from `package.json` scripts, `Makefile`, or CONTRIBUTING.md instructions) and check the exit code. If no test command is discoverable, mark as "Unable to verify automatically — manual check needed."
- **Documentation:** Are doc files updated if the change is user-facing? Check `git diff --name-only` for files in `docs/`, `doc/`, or matching `*.md`.
- **Changelog:** Is there a changelog entry? Check `git diff --name-only` for `CHANGELOG*`, `CHANGES*`, `HISTORY*` files.
- **Code style:** Run the project's formatter/linter command if discoverable (from `package.json` scripts, `Makefile`, or CONTRIBUTING.md instructions) and check the exit code. If the command is not discoverable, mark as "Unable to verify automatically — manual check needed."
- **Commit format:** Does the planned commit message match the required format?
- **Branch target:** Parse the required branch name from the guidelines (e.g., "branch from `develop`") and compare against the current base branch. If they differ, mark as a gap.

#### 4. Present compliance checklist

```
## CONTRIBUTING.md Compliance

Source: {path to guidelines file}

- [x] Tests added for new functionality
- [x] Follows conventional commit format
- [ ] **Gap: Changelog entry required** — CONTRIBUTING.md says "Add an entry to CHANGELOG.md"
- [ ] **Gap: Documentation update needed** — CONTRIBUTING.md says "Update the user manual for user-facing changes"
- [x] Code formatted with project linter

{count} of {total} requirements met.
```

#### 5. Handle gaps

**If all requirements met:** Note "All CONTRIBUTING.md requirements satisfied." and proceed to Step 1e.

**If gaps found:**

```
Question: "There are {gapCount} unmet contribution requirements. How would you like to proceed?"
Header: "Compliance"

Options:
1. "Address the gaps (Recommended)" — "Fix the gaps before committing"
2. "Proceed anyway" — "Some requirements may not apply to this change"
3. "Done for now" — "Come back to this later"
```

**"Address the gaps":** For each gap, attempt to resolve it (add changelog entry, update docs, run formatter, etc.). If resolution fails for a gap (tool not installed, requires manual web interaction like CLA signing, introduces new errors), report: "Could not automatically resolve: {requirement}. Reason: {error}." Mark it as requiring manual attention and continue to the next gap. After all gaps have been attempted, re-verify and present the updated checklist. If unresolvable gaps remain, re-present the 3-option prompt. **Soft limit after 3 resolution cycles:** if gaps remain after 3 attempts, note "Some requirements could not be automatically resolved after 3 attempts" and present the proceed/done options.

**"Proceed anyway":** Store skipped requirements in session context as `skippedComplianceRequirements` (list of `{requirement, reason}`). Display to the user: "Proceeding with {count} skipped requirements: {list}." When generating the PR description in Step 8, include a "Compliance Notes" section listing any consciously skipped requirements. Proceed to Step 1e.

**"Done for now":** Report: "Compliance check paused — {resolvedCount} requirements met, {gapCount} remaining. Run `/oss` to resume." Return to the core router.

### 1e. Per-Repo Guidelines Injection (#867)

Fetch any stored guidelines for the target repo. These encode durable maintainer preferences extracted from past PR feedback (#867). Loading them once at the implementation entry point covers every path that lands here — curated-list flow, `review-issue-replies.md` "Start working on this issue", `action-menu.md` "Other" issue selection, and direct invocation.

```bash
GUIDELINES_OUT=$(GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" guidelines view --repo {owner}/{repo} --json 2>/dev/null)
```

Parse `data.exists` and `data.content`:

- **If `data.exists === true` and `data.content` is non-empty:** Store as `repoGuidelines` in session context for downstream use (review dispatches in Step 3, PR description generation in Step 8). Display to the user once before continuing:

  > **Maintainer preferences for {owner}/{repo}** (from past PR feedback):
  >
  > {data.content}
  >
  > These take precedence over CONTRIBUTING.md when they conflict. When implementing, flag any case where your proposed approach contradicts a stated preference so the user can confirm.

- **If `data.exists === false`** or `data.storageMode === 'local-unavailable'`: skip silently. Per-repo guidelines are opt-in and only available in Gist mode.

- **If the command fails** (network error, malformed output): skip silently. Never block implementation on guidelines unavailability — the flow must work even when the guidelines layer is offline.

Proceed to Step 2.

---

## Step 2: Stage and Commit

- Stage the specific changed files (not `git add -A`)
- If staging fails for any file, report which file(s) failed and why. Offer: "Retry" / "Proceed with staged files only" / "Done for now". Do NOT proceed to commit without user confirmation.
- Commit following the repo's conventional commit format
- If commit fails (e.g., pre-commit hook failure, empty commit):
  - Report the specific error to the user
  - If pre-commit hook failed, show the hook output and offer to fix the issues
  - Do NOT proceed to Step 3
- **Do NOT add AI attribution** (no Co-Authored-By, no "Generated with" mentions)

---

## Step 3: Local Review Cycle

**Trigger:** After local commit in Step 2. Only for new contributions (`isNewContribution === true`).

Initialize `roundNumber = 1`.

### 1. Gather Change Context

Compute `baseBranch` and `mergeBase` (store in session — reused in Steps 4, 6, 7, and 8):

If `upstreamDefault` and `upstreamRemote` are available from Step 1b, use them directly:

```bash
baseBranch="$upstreamDefault"    # e.g., "main", "master", "develop"
remote="$upstreamRemote"         # e.g., "upstream" or "origin"
```

If not available (e.g., Step 1b was skipped or failed), fall back to detection:

```bash
baseBranch=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}')
remote="origin"
```

**If `$baseBranch` is still empty:** Report: "Could not determine the default branch. Please specify the base branch name (e.g., main, master, develop)." Do NOT silently default to "main".

```bash
if ! git fetch "$remote" "$baseBranch" 2>/dev/null; then
  echo "Warning: git fetch failed — diffs may be based on stale data."
fi
mergeBase=$(git merge-base "$remote/$baseBranch" HEAD 2>/dev/null) || true
```

Use `git diff $mergeBase..HEAD` for the full branch diff. If `$mergeBase` is empty, fall back to `$remote/$baseBranch...HEAD`. If neither works, report error — do NOT dispatch agents without diff context. Read `CONTRIBUTING.md` and lint configs if not already loaded.

**Investigation verification:** If investigation findings from Phase A are available in session context, the user was offered a verification checkpoint before implementation began (see `work-through-issues.md` — Investigation Verification Checkpoint). Verified findings should be trusted; flagged concerns should be monitored during review.

### 2. Dispatch Scope-Aware Review Agents

**See `workflows/dispatch-review.md`** — the canonical multi-agent dispatch template (agent roster, SCOPE block, convergence loop, fallback, report format).

Caller-specific inputs for this workflow:
- `issueContext = { title: issueContext.title, url: issueContext.url }` — the SCOPE block is required for new contributions.
- `reviewDiff = git diff $mergeBase..HEAD` (full branch diff from sub-step 1).
- `workingDir` = local repo path.
- `reviewPass = 1`, `agentsWithFindings = []`.

Initialize `roundNumber = 1` for the outer loop, then run the dispatch-review template. The convergence loop in that template handles re-dispatch automatically.

### 3. Consolidate and Present

Use the "In-Scope vs Out-of-Scope" split described in `dispatch-review.md` — since `issueContext` is provided, split findings into:
- **In-Scope** (Critical / Recommended / Minor) — changes related to the issue.
- **Out-of-Scope (pre-existing)** — Critical-severity findings only.

Include the test-coverage assessment from `pr-test-analyzer`.

```
## Local Review — Round {roundNumber}

### In-Scope Findings
[Critical / Recommended / Minor — per dispatch-review.md format]

### Out-of-Scope (pre-existing)
- {list, if any Critical-severity pre-existing issues were flagged}

### Test Coverage
- {assessment from pr-test-analyzer}
```

### 4. User Decision

**If Critical/Recommended findings:** "Address findings" / "Show full diff" / "Finalize anyway" / "Done for now"
**If clean:** "Finalize (Recommended)" / "Show full diff" / "Done for now"

### 5. Handle Choice

**"Address findings":** Fix → commit → increment `roundNumber` → loop to sub-step 1. Only increment `roundNumber` if the commit succeeds. If commit fails, report error and offer retry/done without incrementing. **Soft limit after 3 rounds:** suggest finalizing (diminishing returns).

**"Show diff":** Output `git diff $mergeBase..HEAD` as code block. If the diff command fails, recompute `$mergeBase` and retry. If still failing, offer "Continue without diff" / "Retry" / "Done for now". Then offer: "Finalize" / "Fix something" / "Done for now".

**"Finalize":** → Step 4 (Integration Check) below

**"Done for now":** Report: "Your changes are saved locally on branch `{branchName}`. Run `/oss` to resume." Return to the core router (`commands/oss.md`).

---

## Step 4: Integration Check for New Files

**Trigger:** After Step 3 finalized. Only for new contributions.

Review agents see diff contents but can't detect whether new files are wired into the codebase. This catches "dead code" PRs.

### Flow

1. **Find new files:** `git diff --name-only --diff-filter=A "$mergeBase"..HEAD`. If `$mergeBase` is invalid, recompute it. If no new files → skip to Step 5.

2. **Check references:** For each new file, search for its name stem in the source tree (grep for imports/registrations, excluding the file itself). Adjust file extensions to match the repo's language.

3. **Flag unreferenced files:** If any new file has zero references, warn the user and offer:
   - "Investigate and fix" — find entry points, add missing imports, commit. If git operations fail, report error and offer retry/skip/done. Do NOT proceed to Step 5 unless the commit succeeds or the user explicitly chooses "Skip".
   - "Skip — files are referenced differently" — e.g., dynamically loaded, auto-discovered
   - "Done for now" — leave changes local

**If all files referenced or user resolves:** → Step 5 (Manual Testing)

---

## Step 5: Manual Testing Prompt

**Trigger:** After Step 4 (Integration Check) completes or is skipped. Only runs for new contributions (`isNewContribution === true`).

Automated review catches code patterns, but cannot verify runtime behavior (UI rendering, keyboard shortcuts, browser behavior, CLI output, etc.). This step gives the user a chance to manually verify the feature works before finalizing.

**Auto-skip when ALL of the following are true:**
- The change is a utility function, library code, or backend logic (no visual/UI component)
- All relevant automated test suites pass
- Manual testing would require non-trivial environment setup (e.g., CSP headers, specific server config, browser extension loading)

When auto-skipping, note: "Skipping manual testing — non-visual change, all automated tests pass, and manual testing would require non-trivial environment setup." Then proceed directly to Step 6.

### 1. Prompt for Manual Testing

```
Question: "Would you like to manually test the changes before finalizing?"
Header: "Testing"

Options:
1. "Yes — help me set up testing" — "Walk through building/running the project to test locally"
2. "Skip — proceed to finalize (Recommended for trivial changes)" — "Go directly to human review"
3. "Done for now" — "Save changes locally, come back later"
```

### 2. Handle User Choice

**"Yes — help me set up testing":**
1. Check for build/test instructions in the repo:
   - `CONTRIBUTING.md` (or `contributingGuidelines` from session context) — look for "Development", "Testing", "Building" sections
   - `README.md` — look for "Getting Started", "Development" sections
   - `package.json` scripts — `build`, `dev`, `start`, `test`
   - `Makefile`, `justfile`, `taskfile.yml` — common build targets
   - `Cargo.toml` — check `[package] name` for correct crate/binary names; check `[workspace]` members for monorepo packages
   - `pyproject.toml`, `setup.py`, `setup.cfg` — Python project metadata

2. **Verify before presenting** — before giving any build/test instructions to the user (keep verification fast — avoid full builds or unbounded searches):
   - **Package/target names:** Read the actual build file (e.g., `Cargo.toml`, `package.json`) to get the correct package name. Do NOT guess from the repo or directory name — these often differ (e.g., repo `nickel` but package `nickel-lang-cli`). If the build file cannot be read or does not contain a package name (e.g., workspace root `Cargo.toml` without `[package]`, malformed file), note in the instructions: "Could not determine package name from {file}: {reason}. Please verify the correct package/binary name before running these commands."
   - **File paths:** For any file path referenced in instructions, verify it exists with `ls` or `test -f`. If a path does not exist, search for the correct path before presenting (e.g., `find . -name "json.yaml" -path "*/convert/*" -maxdepth 5`). If the correct path cannot be found, note: "Referenced file `{path}` was not found. This may indicate the file was renamed or moved — verify the correct path manually."
   - **Commands:** If practical, do a dry-run or syntax check of build commands before presenting them (e.g., `cargo check` instead of `cargo build`). Not all tools support dry-run for build scripts (e.g., `npm run build --dry-run` is NOT valid — npm only supports `--dry-run` for `publish` and `pack`). If a dry-run is not available, skip pre-verification for that command and note: "Could not pre-verify `{command}` (no dry-run available)." If a dry-run fails, include the failure prominently: "Warning: `{command}` failed during pre-verification with: `{error}`. This may indicate missing dependencies or toolchain issues."

3. Walk the user through building/running the project based on verified instructions
4. For browser extensions: help with loading the unpacked extension
5. For CLI tools: help with running the tool locally
6. For web apps: help with starting the dev server
7. After the user has tested, re-prompt:
   ```
   Question: "How did testing go?"
   Header: "Testing"

   Options:
   1. "Tests passed — proceed to finalize (Recommended)" — "Everything works as expected"
   2. "Found issues — go back to fix" — "Make additional changes before finalizing"
   3. "Done for now" — "Save changes locally, come back later"
   ```

**"Found issues — go back to fix":**
- User makes fixes (with assistance as needed)
- Stage and commit the fixes
- **If any git operation fails** (stage, commit), report the specific error and offer: "Retry" / "Done for now". Do NOT loop back to Step 3 unless the commit succeeds.
- Loop back to Step 3 sub-step 1 (re-review with agents) above

**"Tests passed — proceed to finalize" / "Skip — proceed to finalize":**
- **→ Proceed to Step 6 (Human Review) below**

**"Done for now":**
- Report: "Your changes are saved locally on branch `{branchName}`. Run `/oss` later to continue."
- Return to the core router (`commands/oss.md`)

---

## Step 6: Human Review

**Trigger:** After Step 5 (Manual Testing) completes or is skipped. Only runs for new contributions (`isNewContribution === true`).

This is the final quality gate before squash and PR creation. The user reviews the complete diff and confirms the work is ready.

### 1. Pre-Readiness Verification

Before showing the diff, verify the review cycle was completed:

1. Confirm lint and tests were run and passed in this session
2. Confirm review agents were dispatched and all Critical/Recommended findings addressed
3. If any of these are missing, run them now before proceeding

If lint/tests have not been run:
> "Hold on — running lint and tests before finalizing..."
Run the repo's lint and test commands. If they fail, fix and loop. **Soft limit after 3 attempts:** report remaining failures and offer: "Proceed to final review anyway" / "Done for now".

If review agents have not been dispatched:
> "Hold on — running review agents before finalizing..."
Dispatch the full review suite (see Step 3) and run the convergence loop. If findings are reported, fix and re-run until convergence. **Soft limit after 3 rounds:** report remaining findings and offer: "Proceed to final review anyway" / "Done for now".

Only proceed to sub-step 2 after all checks pass or the user explicitly chooses to proceed.

### 2. Present Final Diff

Show the complete branch diff with summary:

```bash
git diff --stat $mergeBase..HEAD
```

```
## Final Review

Branch: {branchName}
Files changed: {count}
Insertions: {count}, Deletions: {count}
Issue: {issueContext.url}
```

Then show the full diff: `git diff $mergeBase..HEAD`

### 3. User Confirmation

```
Question: "Review complete. How would you like to proceed?"
Header: "Final Review"

Options:
1. "Looks good — proceed to finalize (Recommended)" — "Squash, push, and create PR"
2. "I want to make changes" — "Go back and edit before finalizing"
3. "Done for now" — "Save locally, come back later"
```

**"Looks good":** → Proceed to Step 7 (Squash + Reword)

**"I want to make changes":** User makes edits, stage and commit the changes. If any git operation fails (stage, commit), report the specific error and offer: "Retry" / "Done for now". Do NOT loop back to Step 3 unless the commit succeeds. Then loop back to Step 3 (re-review with agents).

**"Done for now":** Report: "Your changes are saved locally on branch `{branchName}`. Run `/oss` later to continue." Return to the core router.

---

## Step 7: Squash + Reword

**Trigger:** After Step 6 completes. Only for new contributions.

### Flow

1. **Count commits:** Validate `$mergeBase` (recompute if invalid), then `git rev-list --count "$mergeBase"..HEAD`. If only 1 commit → skip to Step 8.

2. **Check config:** Read squash setting from CLI: `config --json` (check `squashByDefault`, default `true`). If `false` → Step 8. If `"ask"` → prompt user.

3. **Generate message:** Create a commit message covering all work (implementation + tests + fixes). Follow repo's commit format, include issue reference. **Present to user for approval BEFORE squashing:**
   - "Approve and squash (Recommended)" / "Edit message" / "Skip squash" / "Done for now"

4. **Squash (after user approval):** Run each command individually — check for failure before proceeding:
   ```bash
   git tag -d oss-autopilot-pre-squash 2>/dev/null  # cleanup stale tag
   git tag oss-autopilot-pre-squash                  # safety tag — MUST succeed
   git reset --soft "$mergeBase"
   git commit -m "{approved message}"
   git tag -d oss-autopilot-pre-squash               # cleanup after success
   ```
   **CRITICAL: If the safety tag creation fails, do NOT proceed with the squash.** Report: "Could not create safety recovery tag. Aborting squash to protect your work." Offer: "Retry" / "Skip squash" / "Done for now".
   On any other failure: automatically recover via `git reset --hard oss-autopilot-pre-squash` (restores pre-squash commit history), report error, offer "Retry squash" / "Skip squash — proceed with multiple commits" / "Done for now".

**→ Step 8 after successful squash**

---

## Step 8: Push and Create PR

**Trigger:** After Step 7 (Squash + Reword) completes or is skipped. Only runs for new contributions (`isNewContribution === true`).

**CRITICAL: This step must NOT be reached without completing Steps 3 (review cycle), 4 (integration check), 5 (manual testing), 6 (human review), and 7 (squash, or explicitly skipped). If a PR is created before these steps, the workflow has been bypassed — this is a bug.**

### 1. Upstream Drift Check (Mandatory)

The fix could have been merged upstream while this session was active. The CONTRIBUTING-style "no other open PRs" check that ran earlier passes vacuously when the duplicate has merged, so re-check the upstream history right before the irreversible push.

```bash
upstreamRepo=$(echo "{issueContext.url}" | sed -n 's|https://github.com/\([^/]*/[^/]*\)/.*|\1|p')
upstreamDefault="${upstreamDefault:-$(gh repo view "$upstreamRepo" --json defaultBranchRef --jq '.defaultBranchRef.name')}"
remote="${upstreamRemote:-upstream}"
git remote get-url "$remote" >/dev/null 2>&1 || remote="origin"

git fetch "$remote" "$upstreamDefault" 2>/dev/null

mergeBase=$(git merge-base "$remote/$upstreamDefault" HEAD 2>/dev/null)
touchedFiles=$(git diff --name-only "$mergeBase" HEAD 2>/dev/null)

# Find commits on upstream main since mergeBase that touch any file we changed.
overlappingCommits=""
if [ -n "$touchedFiles" ]; then
  overlappingCommits=$(git log "$mergeBase..$remote/$upstreamDefault" --oneline -- $touchedFiles 2>/dev/null)
fi
```

**If `$overlappingCommits` is empty:** Proceed to "2. Show PR Summary".

**If `$overlappingCommits` is non-empty:** Surface the commits inline:

```
## ⚠ Upstream drift detected

`{remote}/{upstreamDefault}` has commits since this branch diverged that touch the same files as your diff:

{overlappingCommits}

The same fix may have already merged. Before pushing, re-vet the issue:
  - Open the issue URL: {issueContext.url}
  - Check the issue's state and any "Closed by" link
  - Inspect the listed commits with `git show <sha>` to compare scope
```

Use AskUserQuestion:
1. "Re-vet the issue" — run the issue-scout vet again on `{issueContext.url}`. If the vet returns "already fixed" / "closed", route to "Abandon this branch" below.
2. "Show diff vs upstream" — `git diff $remote/$upstreamDefault..HEAD -- $touchedFiles`. Present and re-prompt with the same options.
3. "Proceed anyway" — "I've verified the listed commits don't conflict with my fix or are unrelated." Continue to "2. Show PR Summary".
4. "Abandon this branch" — Report: "Skipping PR creation. Branch `{branchName}` stays local; you can delete it with `git branch -D {branchName}` once you've confirmed the fix is duplicate." Return to the core router. Do NOT push or create a PR.

**If the fetch fails** (no network, gh CLI error): Note "Could not verify upstream drift — proceeding with caution." Continue to "2. Show PR Summary".

### 2. Show PR Summary

```
## Ready to create PR?

Branch: {branchName}
Title: {conventional title}
Commits: {1 if squashed, N if not}
Files changed: {count}
Issue: {issueContext.url}
```

### 3. Confirm Push

Push (remote, visible) is confirmed separately from PR creation so the user can verify exactly what is about to leave their machine before any irreversible action.

```
Question: "Push branch `{branchName}` to origin?"
Header: "Push"

Options:
1. "Yes, push" — "Push the commit(s) shown above to origin"
2. "View diff first" — "Show git diff $mergeBase..HEAD, then re-prompt"
3. "Done for now" — "Leave changes local, push and create PR later"
```

**"View diff first":** Show `git diff $mergeBase..HEAD`, then re-prompt with the same options.

**"Done for now":** Report: "Your changes are saved locally on branch `{branchName}`. Run `/oss` later to push and create the PR." Return to the core router.

### 4. Push

```bash
git push -u origin HEAD
```

**If push fails**, report the error and offer: "Retry" / "Done for now" — "Your changes are saved locally on branch `{branchName}`. You can push and create the PR later with `/oss`." Do NOT proceed to PR creation without a successful push.

### 5. Confirm PR State and Create PR

After the push succeeds, confirm the PR state separately:

```
Question: "Push succeeded. Create the PR now?"
Header: "Publish"

Options:
1. "Create as ready for review (Recommended)" — "All checks passed, maintainers can review immediately"
2. "Create as draft" — "Create a draft PR for additional iteration"
3. "Not yet" — "Leave the pushed branch in place; I'll open the PR manually"
```

**"Not yet":** Report: "Branch `{branchName}` is pushed to origin but no PR was created. Open one manually when ready via the GitHub UI or `gh pr create`." Return to the core router.

**Always include `--head`** to handle both fork-based and same-repo workflows. The `--head` flag is harmless for same-repo PRs and required for fork-based PRs:

```bash
forkOwner=$(gh repo view --json owner --jq '.owner.login')
branch=$(git branch --show-current)
```

**If `$forkOwner` is empty** (e.g., `gh` not authenticated, network error): fall back to parsing the remote URL: `forkOwner=$(git remote get-url origin | sed -n 's|.*github.com[:/]\([^/]*\)/.*|\1|p')`. If still empty, ask the user to provide their fork owner name manually. **If `$branch` is empty** (detached HEAD state, e.g., during a rebase or in CI): report "Cannot create a PR from a detached HEAD. Please check out a named branch first." Do NOT run `gh pr create` with an empty `$forkOwner` or `$branch`.

**Before generating the PR body**, fetch the target repo's PR template:

```bash
oss-autopilot pr-template {upstream-owner}/{upstream-repo} --json
```

If a template is returned (`data.template` is non-null), the template body is the **baseline** for your PR description. You are merging your generated summary INTO it, not replacing it. Specifically:

1. **Preserve the template verbatim.** Do not delete, reorder, or rewrite sections, headings, HTML comments (`<!-- ... -->`), or checklist items. Maintainers and bots (e.g., DCO checkers, changeset enforcers) rely on these — wiping them often violates the repo's contribution rules and reads as careless.
2. **Leave every checkbox unchecked** (`- [ ]`, never `- [x]`). The contributor must actively confirm each item, which is the entire point of a checklist. Pre-checking checklist items defeats the safety mechanism.
3. **Insert your generated summary into the right slot:**
   - If the template has a labeled summary/description heading (e.g. `## Summary`, `## Description`, `## What does this PR do?`, `## Motivation`), put your summary text directly under that heading, replacing only any placeholder text (e.g. `<!-- Describe your change here -->`).
   - Otherwise, prepend a `## Summary` block at the very top with your summary text, leaving the template intact below.
4. **Insert your test plan / verification under any matching template heading** (e.g. `## Testing`, `## How was this tested?`); otherwise append a `## Test plan` block before the template's checklists, again leaving any test-related checklist items in the template untouched.

If no template exists or the command fails (network error, API error), use the default format below — template detection is best-effort and must not block PR creation.

Generate the PR title and body following the target repo's conventions (check `CONTRIBUTING.md`, existing PR formats, and the PR template above). Include:
- Reference to the issue being fixed (e.g., "Fixes #123")
- Brief description of the approach

**If user chose "Create as ready for review":**
```bash
gh pr create --title "{conventional title}" --body "{PR body}" --repo {upstream-repo} --head "$forkOwner:$branch"
```

**If user chose "Create as draft":**
```bash
gh pr create --draft --title "{conventional title}" --body "{PR body}" --repo {upstream-repo} --head "$forkOwner:$branch"
```

**If `gh pr create` succeeds**, store in session context:
- `prNumber` — the PR number returned
- `prUrl` — the PR URL returned
- `baseBranch` — the base branch name (from the PR creation output or `gh repo view --json defaultBranchRef`)

If created as ready:
> "PR #{prNumber} created and ready for review: {prUrl}"

If created as draft:
> "Draft PR #{prNumber} created: {prUrl}. Run `/oss` later to mark it ready."

> **Context tip:** This was a full implementation cycle. Starting a fresh `/oss` session will free up context for more work. You can continue here if needed.

**→ Proceed to Step 9 (compliance check) below**

**If `gh pr create` fails:**
- Report the specific error (include stderr output)
- Offer options:
  1. "Retry" — re-run the command
  2. "Try the other PR type" — switch between draft/ready. Only offer this if the error indicates draft PRs are not supported (e.g., GitHub Enterprise). For auth/network errors, this option won't help — omit it.
  3. "Done for now" — leave changes pushed, create PR manually later

- **Do NOT proceed to Step 9 without a valid `prNumber` and `prUrl`**

---

## Step 9: Compliance Check

**For PRs that completed the full draft-first workflow** (Steps 3–8, i.e., `isNewContribution === true` and all steps completed): Skip the general compliance check. The PR was already reviewed by 5+ agents, integration-checked, manually tested, and squashed. However, if `skippedComplianceRequirements` from Step 1d is non-empty, remind the user:

> "Compliance check skipped — this PR went through the full draft-first review workflow. Note: {count} CONTRIBUTING.md requirement(s) were consciously skipped in Step 1d: {list}. Verify these don't need manual attention before maintainer review."

If no requirements were skipped:

> "Compliance check skipped — this PR went through the full draft-first review workflow."

**For all other PR updates** (existing PRs, quick fixes, responses to maintainer feedback): Always offer a compliance check:

> "Would you like me to run a compliance check on this PR to ensure it meets opensource.guide best practices?"

Dispatch the `pr-compliance-checker` agent with the PR URL.

### Test Coverage Requirements

**Include tests when the repo has test infrastructure and the change involves code (not docs-only, config-only, or trivial typo fixes).**

Before submitting a PR, check if the repo has a test directory:
- `test/`, `tests/`, `__tests__/`, `spec/`

---

## Step 10: Post-PR List Continuity

**Trigger:** After creating a PR for an issue that came from the curated issue list (`issueListPath`).

This step ensures the user's issue list stays current and offers to continue through remaining items.

### 1. Offer to update the list file

Ask the user:

```
Question: "Update your issue list to mark this as done?"
Header: "List update"

Options:
1. "Yes, mark it done with PR link (Recommended)"
2. "No, I'll update it manually"
```

If yes, run the deterministic `list-mark-done` CLI command (#1299) — it strikes through the issue line, appends the `**Done**` sub-bullet, and strikes through the repo heading if all issues under it are now done. Idempotent on a re-run.

```bash
<prefix> list-mark-done <issue-url> --pr-url <pr-url> --pr-status "<brief-status>" --list-path <issueListPath> --json
```

Example invocation:

```bash
<prefix> list-mark-done https://github.com/suitenumerique/meet/issues/804 \
  --pr-url https://github.com/suitenumerique/meet/pull/42 \
  --pr-status "CI passing" \
  --list-path /Users/me/issues.md --json
```

Inspect the JSON output before announcing anything:

- `success: true` with `data.marked: true` → the file was updated. Continue to step 2. Note that `data.remainingUnderRepo` reports issues left under THIS repo's heading only — for the whole-list `remainingCount` in step 2, use `availableCount - 1` from the session-start `data.issueList`.
- `success: true` with `data.marked: false` and `data.reason: "already marked done"` → idempotent re-run. Tell the user the line was already struck. Use the same whole-list `remainingCount` calculation (don't double-decrement).
- `success: false` with the error mentioning "Issue URL not found" → STOP. Do NOT announce the list was updated and do NOT advance to step 2. Surface the error to the user with the URL and `--list-path` you used; ask whether to retry with a different path/URL or fall back to a manual edit.

Do NOT hand-edit the list file with the Edit tool; the deterministic command avoids drift between this prose and the marker logic.

### 2. Show remaining count

After updating (or skipping update):

```
Issue list updated! {remainingCount} issues remaining, {completedCount} done.
```

### 3. Offer next action

Use AskUserQuestion:
- "Pick another from your list" (if `remainingCount > 0`) — "{remainingCount} issues remaining"
- "Search GitHub for new issues" — "Find fresh contribution opportunities"
- "Done for now" — "End session with summary"

If `remainingCount === 0`:
```
All issues from your list have been addressed! Nice work.
```
Then offer:
- "Search GitHub for new issues"
- "Find more issues to add to your list"
- "Done for now"

**After Step 10 completes (or is skipped):**
Reset session state: `isNewContribution = false`, clear `issueContext`, `prNumber`, `prUrl`, `baseBranch`, `roundNumber`.

**Route based on choice:**
- "Pick another" → Read `${CLAUDE_PLUGIN_ROOT}/workflows/work-through-issues.md` — "Handle Pick Issue From List" section
- "Search GitHub" → Return to the core router (`commands/oss.md`) — "Handle Find New Issues"
- "Done for now" → Return to the core router (`commands/oss.md`) — "Session End"
