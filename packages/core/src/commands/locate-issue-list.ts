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
import { UNATTENDED_ENV, ValidationError, errorMessage } from '../core/errors.js';
import { isOwnRepo } from '../core/urls.js';
import { getMachinePath, getMachinePathSource, setMachinePath } from '../core/local-config.js';
import { warn } from '../core/logger.js';

/**
 * The issue list this machine is configured to use, for commands whose
 * `--list-path` is optional. Workflows call those commands without the flag
 * so a stored path is never pasted into shell text. Resolved by
 * {@link detectIssueListPath}: configured lists only, with its checks; never
 * a file found in the current directory.
 */
export function configuredIssueListPath(): string {
  const location = detectIssueListPath();
  if (!location) {
    throw new ValidationError(
      'No usable issue list is configured: none is set, or the configured path is relative, missing, or in a ' +
        'checkout that is not yours. Set one via `oss-autopilot setup --set issueListPath=<absolute path>` or pass --list-path.',
    );
  }
  return location.path;
}

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

const SET_HINT = 'run `setup --set issueListPath=<absolute path>` to use it';

/** The issue-list setting in effect, before any check on the file. */
function configuredIssueList(isQuiet = false): { value: string; source: string } | undefined {
  const { config } = getStateManager().getState();
  const value = getMachinePath('issueListPath', config);
  const source = getMachinePathSource('issueListPath', config);
  // A `probe` record was saved without the user confirming it (a build
  // between #1950 and #1933 did that). The synced value, if any, applies.
  if (source === 'probe') {
    if (!isQuiet) warn('startup', `issueListPath ${value} was auto-detected and never confirmed; ${SET_HINT}`);
    return config.issueListPath ? { value: config.issueListPath, source: 'synced' } : undefined;
  }
  return value && source ? { value, source } : undefined;
}

/**
 * Locate the curated issue-list file this machine is configured to use.
 * Returns undefined when none is configured, or the configured value is
 * relative, missing, or (unless the user set it on this machine) inside
 * someone else's checkout. Callers treat that as "no curated list". A file
 * found in the current directory is never returned here: see
 * {@link suggestIssueListPath} (#1933).
 *
 * @param isForeign - The foreign-checkout check; the long-running dashboard
 *   passes a memoized one so polling does not run Git per request (#2012).
 */
export function detectIssueListPath(isForeign = isForeignCheckout): IssueListLocation | undefined {
  let configured: ReturnType<typeof configuredIssueList>;
  try {
    configured = configuredIssueList();
  } catch (error) {
    warn('startup', `Could not read issueListPath from state: ${errorMessage(error)}`);
    return undefined;
  }
  if (!configured) return undefined;
  const { value, source } = configured;
  // Resolving a relative value against the current directory would pick up
  // whatever file is there (#1933); setup and config store absolute paths.
  if (!path.isAbsolute(value)) {
    warn('startup', `Ignoring relative issueListPath ${value}; ${SET_HINT}`);
    return undefined;
  }
  if (!fs.existsSync(value)) {
    warn('startup', `Configured issueListPath not found at ${value}.`);
    return undefined;
  }
  // A value the user did not set here (synced, adopted) is checked like a
  // probe hit: it may point into a checkout that is not theirs.
  if (source !== 'set' && isForeign(path.dirname(value))) {
    warn('startup', `Ignoring issueListPath ${value}: its checkout has a remote not owned by you; ${SET_HINT}`);
    return undefined;
  }
  return { path: value, source: 'configured' };
}

/** The owner segment of a remote URL on any host (`https://h/o/r`, `ssh://u@h:22/o/r`, `u@h:o/r`). */
function remoteOwner(url: string): string | undefined {
  return (/^[a-z][\w+.-]*:\/\/[^/]+\/([^/]+)\//i.exec(url) ?? /^(?:[^@/]+@)?[^/:]+:([^/]+)\//.exec(url))?.[1];
}

/**
 * True when `dir` is inside a Git checkout that has a remote not owned by
 * the configured user (owner path segment, any host, case-insensitive). A
 * fork clone with an `upstream` remote is foreign, and so is a checkout with
 * no remotes or one Git refuses to read. Not a checkout, or no Git: false.
 * Reads local Git config only; no network.
 */
export function isForeignCheckout(dir: string): boolean {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return false;
  } catch (error) {
    // "dubious ownership" is a checkout Git will not read: foreign.
    return /dubious ownership/.test(String((error as { stderr?: unknown }).stderr));
  }
  let username = '';
  let urls: string[];
  try {
    username = getStateManager().getState().config.githubUsername;
    urls = git('config', '--get-regexp', String.raw`^remote\..*\.url$`)
      .trim()
      .split('\n')
      .map((line) => line.slice(line.indexOf(' ') + 1));
  } catch {
    return true; // no remotes, or git failed inside a checkout
  }
  return !username || urls.some((url) => !isOwnRepo(remoteOwner(url) ?? '', username));
}

/**
 * A curated list found at a known path under the current directory, offered
 * for the user to confirm (#1933). Nothing is saved: the prompt layer asks,
 * and a yes is stored with `setup --set issueListPath=<path>`. Until then the
 * file is not used as the list. Offered only when no list is configured, the
 * run is attended, the path has no shell metacharacters, and the current
 * directory is not someone else's checkout (a repository can ship an
 * `issues.md`).
 */
export function suggestIssueListPath(): IssueListLocation | undefined {
  if (process.env[UNATTENDED_ENV] !== undefined) return undefined;
  try {
    if (configuredIssueList(true)) return undefined;
  } catch (error) {
    warn('startup', `Could not read issueListPath from state: ${errorMessage(error)}`);
    return undefined;
  }
  const probe = ['open-source/potential-issue-list.md', 'oss/issue-list.md', 'issues.md'].find((p) => fs.existsSync(p));
  if (!probe) return undefined;
  const found = path.resolve(probe);
  // The path goes into a quoted shell command in the prompt layer.
  if (/["$\\`\p{Cc}]/u.test(found)) return undefined;
  if (isForeignCheckout(process.cwd())) {
    warn('startup', `Found ${found}, not offered because this checkout has a remote not owned by you; ${SET_HINT}`);
    return undefined;
  }
  return { path: found, source: 'auto-detected' };
}
