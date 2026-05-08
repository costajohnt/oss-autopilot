/**
 * CI-enforced tool detection (#1286).
 *
 * Extracted from `workflows/pre-commit-review.md` Steps 2b and 6a so
 * the same logic isn't reimplemented twice in markdown. Callers
 * supply pre-fetched config snippets (the workflow runs `cat` /
 * `head` against the well-known files); this function does the
 * structured parse.
 *
 * Pure typed helper — no I/O.
 */

export type CIToolName = 'lint' | 'format' | 'typecheck' | 'test' | 'build' | 'commit-format' | 'security-scan';

export interface CIEnforcedToolsInput {
  /** `.pre-commit-config.yaml` contents, or null when the file is missing. */
  preCommitConfigYaml: string | null;
  /** Concatenated contents of `.github/workflows/*.yml` (or null when none). */
  workflowYamls: string | null;
  /** `Makefile` contents, or null when missing. */
  makefile: string | null;
  /** `package.json` contents — used to detect script names. */
  packageJson: string | null;
}

export interface CIEnforcedTool {
  tool: CIToolName;
  source: 'pre-commit' | 'github-workflow' | 'makefile' | 'package-json';
  /** Short snippet that surfaced this tool — useful for explainability. */
  evidence: string;
}

/**
 * Detect which class of tool each input source enforces. The output
 * may contain duplicates (e.g., `test` enforced by both pre-commit
 * and a GitHub workflow); callers can dedupe on `tool` or display
 * each evidence pair separately.
 */
export function getCIEnforcedTools(input: CIEnforcedToolsInput): CIEnforcedTool[] {
  const out: CIEnforcedTool[] = [];

  if (input.preCommitConfigYaml) {
    detectFromHaystack(input.preCommitConfigYaml, 'pre-commit', out);
  }
  if (input.workflowYamls) {
    detectFromHaystack(input.workflowYamls, 'github-workflow', out);
  }
  if (input.makefile) {
    detectFromHaystack(input.makefile, 'makefile', out);
  }
  if (input.packageJson) {
    detectScriptsFromPackageJson(input.packageJson, out);
  }

  return out;
}

function detectFromHaystack(haystack: string, source: CIEnforcedTool['source'], out: CIEnforcedTool[]): void {
  const lower = haystack.toLowerCase();
  const checks: Array<{ tool: CIToolName; pattern: RegExp; evidenceFor: string[] }> = [
    {
      tool: 'lint',
      pattern: /\b(?:eslint|biome|ruff|flake8|rubocop|golangci-lint|clippy|pylint)\b/i,
      evidenceFor: ['eslint', 'biome', 'ruff', 'flake8', 'rubocop', 'golangci-lint', 'clippy', 'pylint'],
    },
    {
      tool: 'format',
      pattern: /\b(?:prettier|biome[\s-]+format|black|gofmt|rustfmt|clang-format)\b/i,
      evidenceFor: ['prettier', 'biome', 'black', 'gofmt', 'rustfmt', 'clang-format'],
    },
    {
      tool: 'typecheck',
      pattern: /\b(?:tsc|mypy|sorbet|pyright|flow)\b/i,
      evidenceFor: ['tsc', 'mypy', 'sorbet', 'pyright', 'flow'],
    },
    {
      tool: 'test',
      pattern: /\b(?:vitest|jest|pytest|rspec|go test|cargo test|mocha)\b/i,
      evidenceFor: ['vitest', 'jest', 'pytest', 'rspec', 'go test', 'cargo test', 'mocha'],
    },
    {
      tool: 'build',
      pattern: /\b(?:tsc --noemit|tsup|esbuild|webpack|cargo build|go build)\b/i,
      evidenceFor: ['tsc --noemit', 'tsup', 'esbuild', 'webpack', 'cargo build', 'go build'],
    },
    {
      tool: 'commit-format',
      pattern: /\b(?:commitlint|conventional-commits)\b/i,
      evidenceFor: ['commitlint', 'conventional-commits'],
    },
    {
      tool: 'security-scan',
      pattern: /\b(?:codeql|semgrep|trivy|gitleaks|snyk)\b/i,
      evidenceFor: ['codeql', 'semgrep', 'trivy', 'gitleaks', 'snyk'],
    },
  ];

  for (const c of checks) {
    if (c.pattern.test(lower)) {
      const evidence = c.evidenceFor.find((e) => lower.includes(e)) ?? c.tool;
      out.push({ tool: c.tool, source, evidence });
    }
  }
}

function detectScriptsFromPackageJson(packageJson: string, out: CIEnforcedTool[]): void {
  let parsed: { scripts?: Record<string, string> };
  try {
    parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  } catch {
    return;
  }
  const scripts = parsed.scripts ?? {};
  const scriptToTool: Array<{ key: RegExp; tool: CIToolName }> = [
    { key: /^lint(:|$)/, tool: 'lint' },
    { key: /^format(:|$)/, tool: 'format' },
    { key: /^typecheck(:|$)|^tsc(:|$)/, tool: 'typecheck' },
    { key: /^test(:|$)/, tool: 'test' },
    { key: /^build(:|$)/, tool: 'build' },
  ];
  for (const [name] of Object.entries(scripts)) {
    for (const m of scriptToTool) {
      if (m.key.test(name)) {
        out.push({ tool: m.tool, source: 'package-json', evidence: `scripts.${name}` });
        break;
      }
    }
  }
}
