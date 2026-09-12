/**
 * Local repos command (#84)
 * Scans configurable directories for local git clones and caches results
 */

import * as fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getStateManager, debug } from '../core/index.js';
import { errorMessage } from '../core/errors.js';
import type { LocalReposOutput, LocalRepoInfo } from '../formatters/json.js';

interface LocalReposOptions {
  scan?: boolean;
  paths?: string[];
}

export type { LocalReposOutput, LocalRepoInfo };

/** Default directories to scan for local clones */
const DEFAULT_SCAN_PATHS = [
  path.join(os.homedir(), 'Documents', 'oss'),
  path.join(os.homedir(), 'dev'),
  path.join(os.homedir(), 'projects'),
  path.join(os.homedir(), 'src'),
  path.join(os.homedir(), 'code'),
  path.join(os.homedir(), 'repos'),
];

// Maximum depth for `.git` directories, matching the previous `find -maxdepth 4` behavior.
const MAX_GIT_DIR_DEPTH = 4;
// Wall-clock bound per scan root, matching the previous `execFileSync` timeout. A scan root like
// `~` can hold millions of entries within four levels; a partial result beats a hung process.
const SCAN_TIMEOUT_MS = 30_000;

interface PendingDirectory {
  directory: string;
  depth: number;
}

function collectGitDirectoryEntries(
  entries: fs.Dirent[],
  directory: string,
  depth: number,
  pending: PendingDirectory[],
  gitDirectories: string[],
): void {
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const childPath = path.join(directory, entry.name);
    const childDepth = depth + 1;

    if (entry.name === '.git') {
      gitDirectories.push(childPath);
    } else if (childDepth < MAX_GIT_DIR_DEPTH) {
      pending.push({ directory: childPath, depth: childDepth });
    }
  }
}

// Find `.git` directories without platform-specific shell tools. Directory symlinks are not
// followed, matching GNU find's default behavior.
function findGitDirectories(scanPath: string): string[] {
  const gitDirectories: string[] = [];
  const pending = [{ directory: scanPath, depth: 0 }];
  const deadline = Date.now() + SCAN_TIMEOUT_MS;

  while (pending.length > 0) {
    if (Date.now() > deadline) {
      debug('local-repos', `Scan of ${scanPath} exceeded ${SCAN_TIMEOUT_MS}ms; returning partial results`);
      break;
    }
    const { directory, depth } = pending.pop()!;
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      debug('local-repos', `Failed to read directory ${directory}`, error);
      continue;
    }

    collectGitDirectoryEntries(entries, directory, depth, pending, gitDirectories);
  }

  return gitDirectories;
}

/** Extract the GitHub "owner/repo" remote from a git directory */
function getGitHubRemote(repoPath: string): string | null {
  try {
    const remoteUrl = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Match HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
    const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];

    // Match SSH: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];

    return null;
  } catch (err) {
    // git remote get-url failed (no remote, not a git repo, or timeout) — skip this repo
    debug('local-repos', `Failed to get GitHub remote for ${repoPath}`, err);
    return null;
  }
}

/** Get the current branch of a git repo */
function getCurrentBranch(repoPath: string): string | null {
  try {
    return (
      execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim() || null
    );
  } catch (err) {
    // git branch --show-current failed — repo may be in detached HEAD state or inaccessible
    debug('local-repos', `Failed to get current branch for ${repoPath}`, err);
    return null;
  }
}

/** Scan directories for git repos, returning a map of owner/repo -> local path */
export function scanForRepos(scanPaths: string[]): Record<string, LocalRepoInfo> {
  const repos: Record<string, LocalRepoInfo> = {};

  for (const scanPath of scanPaths) {
    if (!fs.existsSync(scanPath)) continue;

    // Find `.git` directories up to 4 levels beneath the scan root (repos up to 3 levels deep).
    const gitDirectories = findGitDirectories(scanPath);

    for (const gitDirectory of gitDirectories) {
      const repoPath = path.dirname(gitDirectory);
      const remote = getGitHubRemote(repoPath);
      if (!remote) continue;

      const currentBranch = getCurrentBranch(repoPath);
      repos[remote] = {
        path: repoPath,
        exists: true,
        currentBranch,
      };
    }
  }

  return repos;
}

export async function runLocalRepos(options: LocalReposOptions): Promise<LocalReposOutput> {
  const stateManager = getStateManager();
  const state = stateManager.getState();
  const scanPaths =
    options.paths?.map((p) => path.resolve(p)) ??
    state.config.localRepoScanPaths ??
    DEFAULT_SCAN_PATHS.filter((p) => fs.existsSync(p));

  // Use cached data unless --scan is specified
  if (!options.scan && state.localRepoCache) {
    const cache = state.localRepoCache;
    return {
      repos: cache.repos,
      scanPaths: cache.scanPaths,
      cachedAt: cache.cachedAt,
      fromCache: true,
    };
  }

  const repos = scanForRepos(scanPaths);

  // Cache the results in state
  const cachedAt = new Date().toISOString();
  try {
    stateManager.setLocalRepoCache({ repos, scanPaths, cachedAt });
  } catch (error) {
    const msg = errorMessage(error);
    console.error(`Warning: Failed to cache scan results to disk: ${msg}`);
  }

  return {
    repos,
    scanPaths,
    cachedAt,
    fromCache: false,
  };
}
