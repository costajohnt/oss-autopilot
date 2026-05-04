/**
 * Formatter Detection Module (#703)
 *
 * Programmatically detects formatters/linters configured in a local repo directory
 * and diagnoses CI formatting failures from log output.
 */

import * as fs from 'fs';
import * as path from 'path';
import { debug } from './logger.js';

const MODULE = 'formatter-detection';

export type FormatterName =
  | 'prettier'
  | 'eslint'
  | 'biome'
  | 'black'
  | 'ruff'
  | 'rustfmt'
  | 'gofmt'
  | 'clang-format'
  | 'rubocop';

export interface DetectedFormatter {
  name: FormatterName;
  /** Relative to repo root */
  configPath: string;
  /** e.g., "npx prettier --write ." */
  fixCommand: string;
  /** e.g., "npx prettier --check ." */
  checkCommand: string;
  /** Whether the formatter accepts individual file paths as arguments */
  supportsFileArgs: boolean;
}

export interface FormatterDetectionResult {
  formatters: DetectedFormatter[];
  packageJsonScripts: { name: string; command: string }[];
  repoPath: string;
}

export interface CIFormatterDiagnosis {
  isFormattingFailure: boolean;
  formatter?: FormatterName;
  fixCommand?: string;
  evidence: string[];
}

// ── Prettier config file patterns ──────────────────────────────────────────

const PRETTIER_CONFIG_PATTERNS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.json5',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
];

// ── ESLint config file patterns ────────────────────────────────────────────

const ESLINT_CONFIG_PATTERNS = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  '.eslintrc.json',
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.mjs',
  'eslint.config.ts',
];

// ── package.json script names that indicate formatting ─────────────────────

const FORMAT_SCRIPT_NAMES = ['lint:fix', 'format', 'fmt', 'lint', 'format:check', 'format:fix'];

// ── CI log patterns for each formatter ────────────────────────────────────

const CI_PATTERNS: { formatter: FormatterName; patterns: RegExp[] }[] = [
  {
    formatter: 'prettier',
    patterns: [/Code style issues found/i, /Forgot to run Prettier/i, /prettier --check/i],
  },
  {
    formatter: 'ruff',
    patterns: [/ruff format.*--check/i, /ruff format.*would reformat/i],
  },
  {
    formatter: 'black',
    patterns: [/Oh no! .* files? would be reformatted/i, /black --check/i],
  },
  {
    formatter: 'rustfmt',
    patterns: [/Diff in .*\.rs/i, /rustfmt --check/i, /cargo fmt.*--check/i],
  },
  {
    formatter: 'biome',
    patterns: [/biome check/i, /biome ci/i, /Found \d+ fixable diagnostics?/i],
  },
  {
    formatter: 'eslint',
    patterns: [/eslint.*--fix/i, /eslint\D+\d+ problems?/i],
  },
  {
    formatter: 'gofmt',
    patterns: [/gofmt -d/i, /goimports/i],
  },
  {
    formatter: 'clang-format',
    patterns: [/clang-format/i],
  },
  {
    formatter: 'rubocop',
    patterns: [/rubocop.*offense/i, /rubocop -a/i],
  },
];

/**
 * Safely read and parse a JSON file. Returns undefined on failure.
 */
function readJsonFile(filePath: string): unknown | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    debug(MODULE, `Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Safely read a text file. Returns undefined on failure.
 */
function readTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    debug(MODULE, `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Find the first existing file from a list of candidates in a directory.
 */
function findFirstExisting(dir: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(dir, candidate))) {
      return candidate;
    }
  }
  return undefined;
}

interface ParsedPackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

/**
 * Read and parse package.json once. Returns undefined if not found or invalid.
 */
function readPackageJson(repoPath: string): ParsedPackageJson | undefined {
  return readJsonFile(path.join(repoPath, 'package.json')) as ParsedPackageJson | undefined;
}

/**
 * Extract formatting-related scripts from a parsed package.json.
 */
function extractPackageJsonScripts(pkg: ParsedPackageJson | undefined): { name: string; command: string }[] {
  if (!pkg?.scripts) return [];

  const results: { name: string; command: string }[] = [];
  for (const scriptName of FORMAT_SCRIPT_NAMES) {
    const command = pkg.scripts[scriptName];
    if (command) {
      results.push({ name: scriptName, command });
    }
  }
  return results;
}

/**
 * Check if prettier is listed in devDependencies or dependencies.
 */
function hasPrettierDependency(pkg: ParsedPackageJson | undefined): boolean {
  if (!pkg) return false;
  return !!(pkg.devDependencies?.['prettier'] || pkg.dependencies?.['prettier']);
}

/**
 * Check if a TOML file contains a specific section header.
 */
function tomlHasSection(repoPath: string, fileName: string, sectionPattern: string): boolean {
  const content = readTextFile(path.join(repoPath, fileName));
  if (!content) return false;
  return content.includes(sectionPattern);
}

/**
 * Detect formatters and linters configured in a repository.
 *
 * Checks config files in priority order using fs.existsSync() / fs.readFileSync().
 * Returns all detected formatters, plus any formatting-related package.json scripts.
 *
 * @param repoPath - Absolute path to the repository root directory
 * @returns Detection result with formatters ordered by priority and extracted package.json scripts
 * @throws {Error} If repoPath does not exist or is not a directory
 */
export function detectFormatters(repoPath: string): FormatterDetectionResult {
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error(`Repository path does not exist or is not a directory: ${repoPath}`);
  }

  const formatters: DetectedFormatter[] = [];
  const pkg = readPackageJson(repoPath);

  // 1. Biome (highest priority for JS/TS — replaces prettier + eslint)
  const biomeConfig = findFirstExisting(repoPath, ['biome.json', 'biome.jsonc']);
  if (biomeConfig) {
    formatters.push({
      name: 'biome',
      configPath: biomeConfig,
      fixCommand: 'npx @biomejs/biome check --write',
      checkCommand: 'npx @biomejs/biome check',
      supportsFileArgs: true,
    });
  }

  // 2. Prettier
  const prettierConfig = findFirstExisting(repoPath, PRETTIER_CONFIG_PATTERNS);
  if (prettierConfig) {
    formatters.push({
      name: 'prettier',
      configPath: prettierConfig,
      fixCommand: 'npx prettier --write .',
      checkCommand: 'npx prettier --check .',
      supportsFileArgs: true,
    });
  } else if (hasPrettierDependency(pkg)) {
    formatters.push({
      name: 'prettier',
      configPath: 'package.json',
      fixCommand: 'npx prettier --write .',
      checkCommand: 'npx prettier --check .',
      supportsFileArgs: true,
    });
  }

  // 3. ESLint
  const eslintConfig = findFirstExisting(repoPath, ESLINT_CONFIG_PATTERNS);
  if (eslintConfig) {
    formatters.push({
      name: 'eslint',
      configPath: eslintConfig,
      fixCommand: 'npx eslint --fix .',
      checkCommand: 'npx eslint .',
      supportsFileArgs: true,
    });
  }

  // 4. Rust (Cargo.toml → rustfmt)
  if (fs.existsSync(path.join(repoPath, 'Cargo.toml'))) {
    formatters.push({
      name: 'rustfmt',
      configPath: 'Cargo.toml',
      fixCommand: 'cargo fmt',
      checkCommand: 'cargo fmt --check',
      supportsFileArgs: false,
    });
  }

  // 5. Python — ruff takes priority over black
  const hasPyproject = fs.existsSync(path.join(repoPath, 'pyproject.toml'));
  if (hasPyproject && tomlHasSection(repoPath, 'pyproject.toml', '[tool.ruff]')) {
    formatters.push({
      name: 'ruff',
      configPath: 'pyproject.toml',
      fixCommand: 'ruff format .',
      checkCommand: 'ruff format --check .',
      supportsFileArgs: true,
    });
  } else if (hasPyproject && tomlHasSection(repoPath, 'pyproject.toml', '[tool.black]')) {
    formatters.push({
      name: 'black',
      configPath: 'pyproject.toml',
      fixCommand: 'black .',
      checkCommand: 'black --check .',
      supportsFileArgs: true,
    });
  } else if (fs.existsSync(path.join(repoPath, 'ruff.toml'))) {
    formatters.push({
      name: 'ruff',
      configPath: 'ruff.toml',
      fixCommand: 'ruff format .',
      checkCommand: 'ruff format --check .',
      supportsFileArgs: true,
    });
  }

  // 6. Go
  if (fs.existsSync(path.join(repoPath, 'go.mod'))) {
    formatters.push({
      name: 'gofmt',
      configPath: 'go.mod',
      fixCommand: 'gofmt -w .',
      checkCommand: 'gofmt -d .',
      supportsFileArgs: true,
    });
  }

  // 7. Clang-format
  if (fs.existsSync(path.join(repoPath, '.clang-format'))) {
    formatters.push({
      name: 'clang-format',
      configPath: '.clang-format',
      fixCommand: 'clang-format -i',
      checkCommand: 'clang-format --dry-run --Werror',
      supportsFileArgs: true,
    });
  }

  // 8. RuboCop
  if (fs.existsSync(path.join(repoPath, '.rubocop.yml'))) {
    formatters.push({
      name: 'rubocop',
      configPath: '.rubocop.yml',
      fixCommand: 'rubocop -a',
      checkCommand: 'rubocop',
      supportsFileArgs: true,
    });
  }

  // Extract package.json scripts
  const packageJsonScripts = extractPackageJsonScripts(pkg);

  debug(MODULE, `Detected ${formatters.length} formatters in ${repoPath}`);

  return { formatters, packageJsonScripts, repoPath };
}

/**
 * Diagnose whether CI log output indicates a formatting failure.
 *
 * Pattern-matches known formatter error strings. When repoPath is provided,
 * cross-references with {@link detectFormatters} to provide a targeted fix command.
 *
 * @param logOutput - Raw CI log output to analyze
 * @param repoPath - Optional repo path for cross-referencing with local formatter config
 * @returns Diagnosis with matched formatter, fix command, and evidence strings
 */
export function diagnoseCIFormatterFailure(logOutput: string, repoPath?: string): CIFormatterDiagnosis {
  if (!logOutput.trim()) {
    return { isFormattingFailure: false, evidence: [] };
  }

  const evidence: string[] = [];
  let matchedFormatter: FormatterName | undefined;

  for (const { formatter, patterns } of CI_PATTERNS) {
    for (const pattern of patterns) {
      const match = logOutput.match(pattern);
      if (match) {
        evidence.push(match[0]);
        if (!matchedFormatter) {
          matchedFormatter = formatter;
        }
      }
    }
  }

  if (!matchedFormatter) {
    return { isFormattingFailure: false, evidence: [] };
  }

  // Cross-reference with local detection to get the fix command
  let fixCommand: string | undefined;
  if (repoPath) {
    try {
      const detected = detectFormatters(repoPath);
      const localMatch = detected.formatters.find((f) => f.name === matchedFormatter);
      if (localMatch) {
        fixCommand = localMatch.fixCommand;
      }
    } catch (err) {
      debug(MODULE, `Cross-reference failed for ${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback fix commands when CI-matched formatter wasn't found locally or no repoPath provided
  if (!fixCommand) {
    const fallbackCommands: Record<FormatterName, string> = {
      prettier: 'npx prettier --write .',
      eslint: 'npx eslint --fix .',
      biome: 'npx @biomejs/biome check --write',
      black: 'black .',
      ruff: 'ruff format .',
      rustfmt: 'cargo fmt',
      gofmt: 'gofmt -w .',
      'clang-format': 'clang-format -i',
      rubocop: 'rubocop -a',
    };
    fixCommand = fallbackCommands[matchedFormatter];
  }

  return {
    isFormattingFailure: true,
    formatter: matchedFormatter,
    fixCommand,
    evidence,
  };
}

/**
 * Return the first (highest-priority) detected formatter, or undefined if none found.
 *
 * @param result - Detection result from {@link detectFormatters}
 * @returns The highest-priority formatter, or undefined if none detected
 */
export function getPreferredFormatter(result: FormatterDetectionResult): DetectedFormatter | undefined {
  return result.formatters[0];
}
