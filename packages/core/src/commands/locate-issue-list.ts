/**
 * Curated-list path detection (#1463).
 *
 * Extracted from `startup.ts` so the daily merge-loop reconciliation can
 * locate the list without importing `startup.ts` — that would close an
 * import cycle (startup → daily → merge-loop → startup). `startup.ts`
 * re-exports `parseIssueListPathFromConfig` for back-compat and layers item
 * counts / skipped-issues detection on top of `detectIssueListPath`.
 */

import * as fs from 'node:fs';
import { getStateManager } from '../core/index.js';
import { errorMessage } from '../core/errors.js';
import { warn } from '../core/logger.js';

/**
 * Parse issueListPath from a config file's YAML frontmatter.
 * @param configContent - Raw content of the config.md file
 * @returns The path string or undefined if not found
 */
export function parseIssueListPathFromConfig(configContent: string): string | undefined {
  const match = configContent.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  const frontmatter = match[1];
  const pathMatch = frontmatter.match(/issueListPath:\s*["']?([^"'\n]+)["']?/);
  return pathMatch ? pathMatch[1].trim() : undefined;
}

export interface IssueListLocation {
  path: string;
  source: 'configured' | 'auto-detected';
}

/**
 * Locate the curated issue-list file: state config first, then the legacy
 * config.md frontmatter, then known default paths. Returns undefined when
 * no list exists — callers treat that as "user has no curated list".
 */
export function detectIssueListPath(): IssueListLocation | undefined {
  // 1. Check state.json config (primary)
  try {
    const stateManager = getStateManager();
    const configuredPath = stateManager.getState().config.issueListPath;
    if (configuredPath && fs.existsSync(configuredPath)) {
      return { path: configuredPath, source: 'configured' };
    }
  } catch (error) {
    // State manager may not be initialized yet — fall through to legacy config.md
    warn('startup', `Could not read issueListPath from state: ${errorMessage(error)}`);
  }

  // 2. Fallback: config.md (legacy — will be removed in future)
  const configPath = '.claude/oss-autopilot/config.md';
  if (fs.existsSync(configPath)) {
    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      const configuredPath = parseIssueListPathFromConfig(configContent);
      if (configuredPath && fs.existsSync(configuredPath)) {
        return { path: configuredPath, source: 'configured' };
      }
    } catch (error) {
      console.error('[STARTUP] Failed to read config:', errorMessage(error));
    }
  }

  // 3. Probe known paths
  const probes = ['open-source/potential-issue-list.md', 'oss/issue-list.md', 'issues.md'];
  for (const probe of probes) {
    if (fs.existsSync(probe)) {
      return { path: probe, source: 'auto-detected' };
    }
  }

  return undefined;
}
