# Anti-LLM Policy Detection

OSS Autopilot scans a repository's `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `README.md` before recommending any of its issues. If the scan detects language indicating the project does not accept AI- or LLM-generated contributions, the repo is auto-excluded from discovery with a clear message citing the matched phrase.

This is a **hard skip** — the entire workflow is AI-assisted, so a project with an anti-LLM policy is fundamentally incompatible regardless of how healthy its score otherwise looks.

The rules live in [`packages/core/src/core/anti-llm-policy.ts`](../packages/core/src/core/anti-llm-policy.ts). Changing them affects every user, so this doc is kept in sync with the regex set.

## Design: precision over recall

False positives silently shrink your contribution surface without recourse. The rules only match phrases that combine **a rejection keyword** (no / reject / will be closed / don't accept) with **an AI/LLM noun** (copilot, chatgpt, "AI-generated", etc.).

Examples that do **not** match (and shouldn't):

- *"AI division will be closed at the end of Q4"* — "closed" refers to the division, not contributions.
- *"AI suggestions from your IDE are welcome"* — "suggestions" ≠ rejection.
- *"No Copilot-style autocomplete in our editor"* — describes a feature, not a policy (the regex uses a negative lookahead to skip this).
- *"We don't recommend using ChatGPT for code review"* — not a hard ban.

If you see a false positive in the wild, file an issue with the exact phrase so we can tighten the regex.

## Categories

The scan returns zero or more matches, each tagged with one of three categories:

### `explicit_ban`

The repo directly forbids AI- or LLM-generated contributions.

**Triggering examples:**

- *"No AI-generated code."*
- *"No LLM-authored PRs."*
- *"Banned: AI-assisted contributions."*

Regex (conceptual): `\bno\s+(ai|llm)[-\s](generated|authored|written|assisted|contributions?)` plus explicit `ban(ned|ning)` on `ai|llm`.

### `tool_ban`

The repo bans contributions from specific named tools.

**Triggering examples:**

- *"No Copilot-generated PRs."*
- *"No ChatGPT, no Claude, no Cursor."*
- *"No AI coding tools."*

Regex (conceptual): `\bno\s+(copilot|chatgpt|claude|cursor)(-(generated|authored|assisted|written))?` with a negative lookahead so *"no copilot-style autocomplete"* (a feature description) does **not** match. Plus `\bno\s+ai\s+coding\s+tools?\b`.

### `reject_framing`

The repo explicitly states that AI contributions will be closed, rejected, or not accepted — requires both an AI/LLM qualifier AND a contribution noun AND a rejection verb phrase, all in the same sentence window.

**Triggering examples:**

- *"AI-generated code will be closed without review."*
- *"We do not accept LLM-authored pull requests."*
- *"AI contributions will be rejected."*

## What you see when a repo is flagged

The CLI / agent output includes the category and the exact matching excerpt so you can verify:

```
Skipped: owner/repo
  Category: explicit_ban
  Phrase: "No AI-generated code"
  Excerpt: "…we welcome contributions. No AI-generated code, please…"
  See docs/anti-llm-policy.md for details.
```

The excerpt is a ~80-character window around the match, chosen so you can read the surrounding sentence and judge whether the ban is really about contributions (vs. describing an unrelated feature).

## Appeals / overrides

If the scan flagged a repo that actually welcomes AI help:

1. Verify the phrase in-context by reading the source file the excerpt cites.
2. If it's a false positive, file an issue in this repo with the exact matching text.
3. As a temporary workaround, remove the repo from `aiPolicyBlocklist`:

   ```bash
   oss-autopilot setup --set aiPolicyBlocklist="matplotlib/matplotlib"
   ```

   (Pass the full comma-separated list minus the entry you're removing — `--set` replaces the whole value.)

## Hidden / out-of-band signals

Not every anti-LLM stance is scannable from document text. Maintainers sometimes hide AI-submitted PRs as spam, add comments on closed policy issues, or voice opposition in external channels. The scan cannot see any of that. If you observe such signals during vetting, manually add the repo to `aiPolicyBlocklist` to auto-exclude future searches.

## See also

- [`packages/core/src/core/anti-llm-policy.ts`](../packages/core/src/core/anti-llm-policy.ts) — implementation with inline regex comments.
- [`packages/core/src/core/anti-llm-policy.test.ts`](../packages/core/src/core/anti-llm-policy.test.ts) — pinned-behavior tests for each category.
- [`docs/repo-scoring.md`](./repo-scoring.md) — the other user-visible heuristic that shapes discovery outcomes.
