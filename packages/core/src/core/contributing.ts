/**
 * CONTRIBUTING.md requirement extraction (#1279).
 *
 * Extracted from `workflows/draft-first-workflow.md` Step 1d so the
 * heuristic that pulls actionable requirements out of a project's
 * CONTRIBUTING file lives in typed code instead of workflow prose.
 * Same architectural shape as compliance-score (#1245), repo-vet
 * (#1242), strategy (#1243), and the recent #1252 / #1264 / #1286
 * extractions.
 *
 * Pure typed helper — no I/O. Callers (the workflow runner, the
 * `pr-compliance-checker` agent) read the file themselves and pass
 * the contents in. The extraction step is heuristic regex matching
 * over headings + bullet phrases; it intentionally over-recalls
 * (some false positives) rather than under-recalling.
 *
 * Out of scope (deferred per #1279):
 *  - `findContributingFile(repoPath)` — file-system search for the
 *    guidelines file at one of seven well-known locations.
 *  - `verifyRequirements(...)` — diff-aware satisfaction check per
 *    requirement.
 *  - `checkContributingCompliance(...)` — convenience wrapper that
 *    calls all three.
 *
 * The remaining pieces plumb `extractRequirements()` into specific
 * surfaces; each ships independently.
 */

export type ContributingCategory =
  'tests' | 'documentation' | 'changelog' | 'code_style' | 'commit_format' | 'cla_dco' | 'branch_target' | 'scope';

export interface ContributingRequirement {
  category: ContributingCategory;
  /** One-line description of what the project asks for. */
  description: string;
  /**
   * The line that surfaced the requirement, lightly trimmed. Useful
   * for explainability in agent output ("the project's CONTRIBUTING
   * says: …").
   */
  evidence: string;
}

interface CategoryRule {
  category: ContributingCategory;
  /** Match against a single line; case-insensitive. */
  pattern: RegExp;
  /** Friendly description rendered when the rule matches. */
  description: string;
}

/**
 * Heuristic patterns. Each rule fires once if any line in the
 * document matches its pattern. Rules are ordered by specificity:
 * commit-format and CLA matchers are precise; the broader
 * documentation/scope rules sit at the end so they don't shadow
 * narrower categories.
 */
const RULES: readonly CategoryRule[] = [
  {
    category: 'tests',
    pattern: /\b(?:add|include|write|provide|cover\s+with)\s+(?:unit\s+)?tests?\b/i,
    description: 'Add tests covering the change',
  },
  {
    category: 'tests',
    pattern: /\btest(?:s|ing)?\s+(?:are|is)\s+required\b/i,
    description: 'Tests are required',
  },
  {
    category: 'documentation',
    pattern: /\b(?:update|add|provide)\s+(?:the\s+)?(?:docs?|documentation)\b/i,
    description: 'Update documentation when behavior changes',
  },
  {
    category: 'changelog',
    pattern:
      /\b(?:add|include|update)\s+(?:an?\s+)?(?:entry\s+(?:to|in)\s+)?(?:the\s+)?(?:changelog|CHANGELOG\.md|changeset)\b/i,
    description: 'Add a changelog entry / changeset',
  },
  {
    category: 'changelog',
    pattern: /\bchange(?:log|set)\s+(?:entry|file)\s+(?:is\s+)?required\b/i,
    description: 'Changelog entry / changeset is required',
  },
  {
    category: 'code_style',
    pattern:
      /\b(?:run|use)\s+(?:the\s+)?(?:linter|formatter|prettier|eslint|biome|black|ruff|gofmt|rustfmt|clang-format)\b/i,
    description: 'Run the project formatter / linter before submitting',
  },
  {
    category: 'commit_format',
    pattern: /\bconventional\s+commits?\b/i,
    description: 'Use Conventional Commits format',
  },
  {
    category: 'commit_format',
    pattern: /\bcommit\s+messages?\s+(?:must|should|need)\b/i,
    description: 'Project enforces a commit-message convention',
  },
  {
    category: 'cla_dco',
    pattern: /\b(?:CLA|contributor\s+license\s+agreement|DCO|sign(?:ed)?-off-by|signoff)\b/i,
    description: 'Contributor license / DCO sign-off required',
  },
  {
    category: 'branch_target',
    pattern:
      /\b(?:open|submit|target)\s+(?:a\s+)?(?:PR|pull\s+request).*?(?:against|to|targeting)\s+(?:the\s+)?(\S+)\s+branch\b/i,
    description: 'PR must target a specific branch',
  },
  {
    category: 'scope',
    pattern: /\b(?:one\s+(?:logical\s+)?change|focused\s+PR|atomic\s+commits?)\b/i,
    description: 'Keep PRs focused / atomic',
  },
];

/**
 * Extract structured requirements from a CONTRIBUTING.md (or
 * similar) text. Each rule fires at most once per document — a
 * project that says "tests are required" twice still surfaces a
 * single tests requirement.
 */
export function extractRequirements(content: string): ContributingRequirement[] {
  if (!content || content.trim().length === 0) return [];
  const lines = content.split(/\r?\n/);
  const out: ContributingRequirement[] = [];
  const seenCategoriesPerRule = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const rule of RULES) {
      const ruleKey = `${rule.category}::${rule.pattern.source}`;
      if (seenCategoriesPerRule.has(ruleKey)) continue;
      if (rule.pattern.test(trimmed)) {
        out.push({
          category: rule.category,
          description: rule.description,
          evidence: trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed,
        });
        seenCategoriesPerRule.add(ruleKey);
      }
    }
  }
  return out;
}

/**
 * Convenience: dedupe a requirement list down to one entry per
 * category. Useful for top-line summaries where the agent doesn't
 * need to render every matched rule.
 */
export function dedupeByCategory(requirements: readonly ContributingRequirement[]): ContributingRequirement[] {
  const seen = new Set<ContributingCategory>();
  const out: ContributingRequirement[] = [];
  for (const r of requirements) {
    if (seen.has(r.category)) continue;
    seen.add(r.category);
    out.push(r);
  }
  return out;
}
