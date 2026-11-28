# Draft Files and Approval to Post

> **Read by every flow that stages text for posting or storing.** The draft protocol, the check before drafting a comment, and the one approval rule for posting live here, not in `workflows/reference.md`.

**Prefix:** `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs"` (the same `<prefix>` as in `workflows/reference.md`).

## Draft Files (#1930)

Text that will be posted or stored under the user's name (a comment, a PR body, a commit message, guidelines) is staged in the tool's own draft directory, `~/.oss-autopilot/tmp` (owner-only), never under `/tmp`: a shared directory lets another local user pre-create or swap the file between the user's approval and the command that reads it.

```bash
# Path for a draft file name (letters, digits, ".", "_", "-"); creates the directory with mode 0700.
# Without --json it prints only the path, so it fits in "$(...)".
<prefix> draft path <name> --json

# Read a draft once: data.content is the text to show the user, data.sha256 is its hash.
# Add --untrusted when the text was distilled from other people's writing (guideline proposals):
# content then comes back inside a <github-content> fence, with & and < written as &amp; and &lt;.
<prefix> draft show "<draft-path>" [--untrusted] --json
```

The flow, every time:

1. Run `draft path <name>` on its own, read the path it prints, and write the text there **with the Write tool** (not `echo`, not a heredoc). Use the printed path literally and quoted (a home directory can contain spaces); a shell variable does not survive to the next tool call.
2. Run `draft show "<draft-path>" --json` and show the user `data.content`, complete, inside a code fence longer than any run of backticks in it. What you show comes from that output, not from your memory of what you wrote.
3. After the user approves, run the command with `--body-file` (or `--from-file`) and `--expect-sha256 <data.sha256>`. If the file changed since step 2, the command fails before posting or storing anything: go back to step 2.
4. After an edit, repeat from step 2. Write the file again only when the user dictated the change; if they edited the file on disk, just rerun `draft show`.
5. Delete the draft (`rm -- "<draft-path>"`, that exact path) once the command succeeds, and when the user abandons it. Drafts left behind are removed after 30 days.

### Before drafting a comment (#2009)

Before drafting any comment for the user to post, run `<prefix> policy get --repo <owner/repo> --json`. Draft nothing and hand the thread to the user (link it, say why) when:

- `data.policy.aiPolicy` is `banned` (a repo in `aiPolicyBlocklist` reads as banned), or
- the thread hits a case in "When to Defer to the Human Contributor" (`skills/contribution-ethics/SKILL.md`): maintainer frustration or AI accusations, a visual or subjective call, a heated discussion about AI, ethics, policy or governance.

If `policy get` fails, say so and continue; the defer cases above still apply.

### Approval to post (#2009)

This is the only approval rule for posting; every flow that posts applies it as written here. Step 3 runs only on this answer. After showing the draft text (step 2), ask with AskUserQuestion, options:

1. "Post this comment" — post the text shown, exactly.
2. "Edit before posting" — take the change, then back to step 2.
3. "Don't post" — delete the draft and move on.

A flow may word the question and option 3 for its context (`workflows/pre-commit-review.md` labels it "Skip — don't post a comment"), but option 1 is always "Post this comment" and the rule below does not change.

Post only when the answer contains one of "Post this comment", "post it", "option 1" or "yes, post" (case-insensitive) and no negation word ("don't", "no", "not", "wait", "cancel", "stop", "actually", "never mind", "changed my mind") in the same sentence. A change request, a generic "yes" / "ok" / "looks good" / "User has answered your questions", an empty answer (see "AskUserQuestion Validation Protocol" in `workflows/reference.md`) or anything ambiguous is not approval: do not post; treat a change request as "Edit before posting" and anything else as "Don't post", and say so. Edit rounds re-ask with the same rules. In an unattended run nothing is posted: `post` refuses there.

On a command that posts or stores the text, `--body-file` and `--from-file` require `--expect-sha256`, cannot be combined with another source of the text (`--stdin`, positional words, `--content`), and refuse an empty file. They only read regular files directly inside the draft directory that you own, that are not world-writable and have no other hard link, in valid UTF-8 without a byte order mark; symlinks are refused.
