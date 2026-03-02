/**
 * Check integration command (#83)
 * Detects new files in the current branch that aren't referenced elsewhere
 */

import * as path from 'path';
import { execFileSync } from 'child_process';
import type { CheckIntegrationOutput, NewFileInfo } from '../formatters/json.js';
import { debug } from '../core/index.js';

interface CheckIntegrationOptions {
  base: string;
}

export type { CheckIntegrationOutput, NewFileInfo };

/** File extensions we consider "code" that should be imported/referenced */
const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.vue',
  '.svelte',
]);

/** Files that are typically entry points or config, not expected to be imported */
const IGNORED_PATTERNS = [
  /^\./, // dotfiles
  /\.(test|spec|e2e)\.[^.]+$/, // test files
  /\.(config|rc)\.[^.]+$/, // config files
  /__tests__\//, // test directories
  /\.d\.ts$/, // type declarations
  /\.md$/, // documentation
  /\.json$/, // json files
  /\.ya?ml$/, // yaml files
];

/** Get the basename without extension for import matching (TS/JS) */
function getImportName(filePath: string): string {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  // index files are imported by their directory name
  if (base === 'index') {
    return path.basename(path.dirname(filePath));
  }
  return base;
}

/** Suggest likely entry points for a new file based on its location */
function suggestEntryPoints(newFile: string, existingFiles: string[]): string[] {
  const dir = path.dirname(newFile);
  const suggestions: string[] = [];

  // Look for index files in the same directory
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const indexFile = path.join(dir, `index${ext}`);
    if (existingFiles.includes(indexFile)) {
      suggestions.push(indexFile);
    }
  }

  // Look for barrel/index in parent directory
  const parentDir = path.dirname(dir);
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const parentIndex = path.join(parentDir, `index${ext}`);
    if (existingFiles.includes(parentIndex)) {
      suggestions.push(parentIndex);
    }
  }

  return [...new Set(suggestions)];
}

export async function runCheckIntegration(options: CheckIntegrationOptions): Promise<CheckIntegrationOutput> {
  const base = options.base;

  // Get new files added in this branch vs base
  let newFiles: string[];
  try {
    const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`], {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    newFiles = output ? output.split('\n').filter(Boolean) : [];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to run git diff: ${msg}`, { cause: error });
  }

  // Filter to code files, excluding tests, configs, etc.
  const codeFiles = newFiles.filter((f) => {
    const ext = path.extname(f);
    if (!CODE_EXTENSIONS.has(ext)) return false;
    return !IGNORED_PATTERNS.some((p) => p.test(f));
  });

  if (codeFiles.length === 0) {
    return { newFiles: [], unreferencedCount: 0 };
  }

  // Get all tracked files in the repo for reference checking
  let allFiles: string[];
  try {
    allFiles = execFileSync('git', ['ls-files'], {
      encoding: 'utf-8',
      timeout: 10000,
    })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    // git ls-files failed (e.g. not a git repo) -- proceed without reference list
    debug('check-integration', 'git ls-files failed, reference checking will be skipped', err);
    allFiles = [];
  }

  // For each new file, search for references in the repo
  const results: NewFileInfo[] = [];

  for (const newFile of codeFiles) {
    const importName = getImportName(newFile);
    const fileWithoutExt = newFile.replace(/\.[^.]+$/, '');

    // Search for references using git grep (fast, respects .gitignore)
    let referencedBy: string[] = [];
    // Search for: import from './filename', require('./filename'), or just the filename stem
    const patterns = [
      importName, // bare name (covers most import patterns)
    ];

    // Also search for path-based imports (relative path without extension)
    if (fileWithoutExt.includes('/')) {
      patterns.push(fileWithoutExt);
    }

    for (const pattern of patterns) {
      try {
        const grepOutput = execFileSync('git', ['grep', '-l', '--', pattern], {
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
        if (grepOutput) {
          const matches = grepOutput.split('\n').filter((f) => f !== newFile);
          referencedBy.push(...matches);
        }
      } catch (error: unknown) {
        // git grep exit code 1 = no matches (expected), exit code 2+ = real error
        const exitCode =
          error && typeof error === 'object' && 'status' in error ? (error as { status: number }).status : null;
        if (exitCode !== null && exitCode !== 1) {
          const msg = error instanceof Error ? error.message : String(error);
          debug('check-integration', `git grep failed for "${pattern}": ${msg}`);
        }
      }
    }

    // Deduplicate
    referencedBy = [...new Set(referencedBy)];

    const isIntegrated = referencedBy.length > 0;
    const info: NewFileInfo = {
      path: newFile,
      referencedBy,
      isIntegrated,
    };

    if (!isIntegrated) {
      info.suggestedEntryPoints = suggestEntryPoints(newFile, allFiles);
    }

    results.push(info);
  }

  const unreferencedCount = results.filter((r) => !r.isIntegrated).length;
  return { newFiles: results, unreferencedCount };
}
