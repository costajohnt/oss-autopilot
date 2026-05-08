# Workflow: Edit Existing Guidelines

Companion to `extract-learnings.md` for the **manual edit path** —
load existing per-repo guidelines, let the user edit them, store the
result. No corpus fetch, no LLM extraction step (#1283).

Auto-fired by the `/oss-guidelines` slash command when the user picks
"Edit guidelines" from the action menu. Can also be invoked manually
when the user wants to update guidelines without waiting for fresh
PR comments.

## Why this is its own workflow

The `extract-learnings.md` flow defaults to "fetch fresh corpus → run
extraction → propose update → user edits/stores". That's the right
default when the user wants the system to surface new conventions.

But sometimes the user just wants to:

- Add a rule the corpus didn't capture (a convention they've seen in
  reviews but the extractor missed).
- Remove a stale entry (a convention that's no longer followed).
- Reorder / re-section the guidelines for readability.

For all three, the corpus fetch + extraction is wasted work. This
workflow is the lightweight load → edit → store path.

## Preconditions

- Gist persistence is configured. Guidelines storage requires Gist
  mode (#867 semantics). If `config.persistence` is `local`, surface
  the standard "this requires Gist persistence" message and exit.
- A `repo` argument is provided (`owner/repo`). The slash command
  passes this through; manual invocations must supply it.

## Steps

1. **Load the current guidelines** for `repo` via
   `cli.bundle.cjs guidelines view --repo OWNER/REPO --json` (or the
   `mcp__plugin_oss-autopilot_oss-autopilot__guidelines-get` MCP tool
   when available).

   - If no guidelines exist, surface a one-line nudge to run
     `extract-learnings` first and exit. This workflow is for editing
     existing entries, not bootstrapping new ones.

2. **Write the current content to a temp draft file** at
   `/tmp/oss-autopilot-guidelines/<owner>-<repo>-<timestamp>.md`.
   This mirrors the `draft-review-post` skill's convention (#1248) so
   the user has a stable path to inspect.

3. **Show the rendered content to the user** and offer:
   - "Open in default editor" — call `${EDITOR:-vi} <path>` for the
     user.
   - "Paste replacement here" — accept the new markdown via
     `AskUserQuestion`'s textarea. Use this when the user has an
     edited copy on the clipboard already.
   - "Cancel" — exit without saving.

4. **Validate the edited content** before storing:
   - Non-empty (a zero-length file is treated as "I want to delete";
     redirect to `guidelines reset` instead, which has the right
     tombstone semantics).
   - Under the 8 KB byte budget (the Gist storage cap from #867).
   - No raw secrets pattern matches (the same regex set
     `guard-public-posts.sh` uses; defense-in-depth, not authoritative).

5. **Store via the CLI** —
   `cat <draft-path> | cli.bundle.cjs guidelines store --repo OWNER/REPO`.

   - On success, print a one-line confirmation with the new byte size
     and timestamp.
   - On failure, surface the error and offer to retry, save the draft
     for later, or cancel.

6. **Show a diff summary** between the prior content and the stored
   content for the user's audit trail. The draft path stays around
   until the user runs `/oss-guidelines` again (or manually deletes
   it).

## What this workflow does NOT do

- Does not fetch fresh PR comments. Use `extract-learnings.md` for
  that.
- Does not run an LLM extraction step. The user is the editor here.
- Does not modify multiple repos. One invocation, one repo.

## Out of scope (deferred follow-ups)

- A side-by-side diff renderer for Step 6. Today's "show before / show
  after" prose works; a diff view is nicer but not load-bearing.
- A "compare with the corpus's current state" view that re-runs
  extraction and shows what new rules the corpus would surface
  without storing them. That's an `extract-learnings.md` enhancement,
  not this workflow's concern.
