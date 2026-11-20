/**
 * Curated-list path detection (#1463).
 *
 * Extracted from `startup.ts` so the daily merge-loop reconciliation can
 * locate the list without importing `startup.ts` — that would close an
 * import cycle (startup → daily → merge-loop → startup). `startup.ts` layers
 * item counts / skipped-issues detection on top of `detectIssueListPath`.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getStateManager } from '../core/index.js';
import { UNATTENDED_ENV, errorMessage } from '../core/errors.js';
import { isOwnRepo } from '../core/urls.js';
import { getMachinePath, getMachinePathSource, setMachinePath } from '../core/local-config.js';
import { warn } from '../core/logger.js';

export interface IssueListLocation {
  path: string;
  source: 'configured' | 'auto-detected';
}

/**
 * Persist an absolute list/skip path for this machine (the local settings
 * file, never the synced config: #1950), but only when it differs from the
 * value in effect (avoid a write on every run). Upgrading a
 * relative/auto-detected value to absolute makes the location stick across
 * working directories, so `/oss` invoked from anywhere keeps finding the list
 * and skip file instead of silently no-opping the vet/skip/list-maintenance
 * flow (#1577). Shared by the list detection here and the skip-path resolution
 * in startup.ts.
 */
export function persistConfigPath(key: 'issueListPath' | 'skippedIssuesPath', absolutePath: string): void {
  try {
    const { config } = getStateManager().getState();
    if (getMachinePath(key, config) === absolutePath) return;
    // A configured value made absolute keeps the source it had; one that
    // came from the synced config counts as adopted.
    const current = getMachinePathSource(key, config);
    setMachinePath(key, absolutePath, current === undefined || current === 'synced' ? 'adopted' : current);
  } catch (error) {
    // Best-effort — the current run still uses the resolved path; the next run
    // just re-detects. Log so the failure is debuggable.
    warn('startup', `Could not persist absolute ${key}: ${errorMessage(error)}`);
  }
}

/**
 * Locate the curated issue-list file this machine is configured to use.
 * Returns undefined when no list is configured or it is missing; callers
 * treat that as "user has no curated list". A file found in the current
 * directory is never returned here: see {@link suggestIssueListPath} (#1933).
 *
 * The returned path is ABSOLUTE (#1577): a relative configured value is
 * resolved against CWD once and persisted, so the vet -> skip ->
 * list-maintenance flow no longer depends on `/oss` running from the list's
 * parent directory.
 */
export function detectIssueListPath(): IssueListLocation | undefined {
  try {
    const { config } = getStateManager().getState();
    const configuredPath = getMachinePath('issueListPath', config);
    // A `probe` record was saved without the user confirming it (a build
    // between #1950 and #1933 did that), so it is not trusted as configured.
    if (configuredPath && getMachinePathSource('issueListPath', config) !== 'probe') {
      // Resolve a relative configured value against CWD to an absolute path so
      // the location is stable no matter where `/oss` runs (#1577).
      const resolved = path.resolve(configuredPath);
      if (fs.existsSync(resolved)) {
        if (resolved !== configuredPath) persistConfigPath('issueListPath', resolved);
        return { path: resolved, source: 'configured' };
      }
      // A path WAS configured but nothing is there. Surface it prominently
      // instead of silently degrading to undefined (#1577): a large configured
      // list being ignored is otherwise easy to miss.
      warn(
        'startup',
        `Configured issueListPath not found at ${resolved} (cwd ${process.cwd()}). ` +
          `Set an absolute issueListPath, or run from its directory.`,
      );
    }
  } catch (error) {
    warn('startup', `Could not read issueListPath from state: ${errorMessage(error)}`);
  }
  return undefined;
}

/**
 * True when the current directory is a git checkout whose origin is not a
 * GitHub repository owned by `username`. Reads the local remote only; no
 * network. A directory that is not a checkout, or has no origin, is not
 * foreign.
 */
function cwdIsForeignCheckout(username: string): boolean {
  let remote: string;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return false;
  }
  const owner = /^(?:(?:https|ssh|git):\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+)\//.exec(remote)?.[1];
  return !owner || !username || !isOwnRepo(owner, username);
}

/**
 * A curated list found at a known path under the current directory, offered
 * for the user to confirm (#1933). Nothing is saved: the prompt layer asks,
 * and a yes is stored with `setup --set issueListPath=<path>`. Until then the
 * file is not used as the list. No suggestion during an unattended run, or
 * when the current directory is someone else's checkout (a repository can
 * ship an `issues.md`).
 */
export function suggestIssueListPath(): IssueListLocation | undefined {
  if (process.env[UNATTENDED_ENV] !== undefined) return undefined;
  let username = '';
  try {
    username = getStateManager().getState().config.githubUsername;
  } catch (error) {
    warn('startup', `Could not read githubUsername from state: ${errorMessage(error)}`);
  }
  if (cwdIsForeignCheckout(username)) return undefined;
  for (const probe of ['open-source/potential-issue-list.md', 'oss/issue-list.md', 'issues.md']) {
    if (fs.existsSync(probe)) return { path: path.resolve(probe), source: 'auto-detected' };
  }
  return undefined;
}
