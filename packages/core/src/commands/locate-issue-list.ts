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
import * as path from 'node:path';
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
 * Persist an absolute list/skip path back to state config, but only when it
 * differs from what's stored (avoid an autoSave on every run). Upgrading a
 * relative/auto-detected value to absolute makes the location stick across
 * working directories, so `/oss` invoked from anywhere keeps finding the list
 * and skip file instead of silently no-opping the vet/skip/list-maintenance
 * flow (#1577). Shared by the list detection here and the skip-path resolution
 * in startup.ts.
 */
export function persistConfigPath(key: 'issueListPath' | 'skippedIssuesPath', absolutePath: string): void {
  try {
    const stateManager = getStateManager();
    if (stateManager.getState().config[key] !== absolutePath) {
      stateManager.updateConfig({ [key]: absolutePath });
    }
  } catch (error) {
    // Best-effort — the current run still uses the resolved path; the next run
    // just re-detects. Log so the failure is debuggable.
    warn('startup', `Could not persist absolute ${key}: ${errorMessage(error)}`);
  }
}

/**
 * Locate the curated issue-list file: state config first, then the legacy
 * config.md frontmatter, then known default paths. Returns undefined when
 * no list exists — callers treat that as "user has no curated list".
 *
 * All returned paths are ABSOLUTE (#1577): a relative configured value or a
 * known-path probe is resolved against CWD once, then persisted, so the vet →
 * skip → list-maintenance flow no longer depends on `/oss` running from the
 * list's parent directory.
 */
export function detectIssueListPath(): IssueListLocation | undefined {
  // When a configured path exists but its file is missing at resolve-time, a
  // coincidental probe hit below must NOT overwrite the user's configured value
  // in state — it's likely just absent from the current CWD, not wrong.
  let configuredButMissing = false;

  // 1. Check state.json config (primary)
  try {
    const stateManager = getStateManager();
    const configuredPath = stateManager.getState().config.issueListPath;
    if (configuredPath) {
      // Resolve a relative configured value against CWD to an absolute path so
      // the location is stable no matter where `/oss` runs (#1577).
      const resolved = path.resolve(configuredPath);
      if (fs.existsSync(resolved)) {
        if (resolved !== configuredPath) persistConfigPath('issueListPath', resolved);
        return { path: resolved, source: 'configured' };
      }
      // A path WAS configured but nothing is there. Surface it prominently
      // instead of silently degrading to probes/undefined (#1577): a large
      // configured list being ignored is otherwise easy to miss.
      configuredButMissing = true;
      warn(
        'startup',
        `Configured issueListPath not found at ${resolved} (cwd ${process.cwd()}); ` +
          `falling back to auto-detection. Set an absolute issueListPath, or run from its directory.`,
      );
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
      if (configuredPath) {
        const resolved = path.resolve(configuredPath);
        if (fs.existsSync(resolved)) {
          return { path: resolved, source: 'configured' };
        }
      }
    } catch (error) {
      console.error('[STARTUP] Failed to read config:', errorMessage(error));
    }
    // Legacy config.md missing-file case is intentionally not warned/persisted:
    // this branch is slated for removal, and step 1 already covers the primary
    // (state.json) configured path (#1577).
  }

  // 3. Probe known paths. Return the ABSOLUTE path and persist it so the first
  // successful detection sticks from any working directory afterwards (#1577).
  // But NOT when a path was configured-but-missing: the probe hit is likely
  // just absent from the current CWD, so overwriting the user's deliberate
  // config with a coincidental probe file would be the silent-wrong-target bug
  // #1577 set out to kill.
  const probes = ['open-source/potential-issue-list.md', 'oss/issue-list.md', 'issues.md'];
  for (const probe of probes) {
    if (fs.existsSync(probe)) {
      const resolved = path.resolve(probe);
      if (!configuredButMissing) persistConfigPath('issueListPath', resolved);
      return { path: resolved, source: 'auto-detected' };
    }
  }

  return undefined;
}
