/**
 * Local repos command (#84)
 * Scans configurable directories for local git clones and caches results
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { getStateManager } from '../core/index.js';
import { outputJson, outputJsonError, type LocalReposOutput, type LocalRepoInfo } from '../formatters/json.js';

interface LocalReposOptions {
  scan?: boolean;
  paths?: string[];
  json?: boolean;
}

/** Default directories to scan for local clones */
const DEFAULT_SCAN_PATHS = [
  path.join(os.homedir(), 'Documents', 'oss'),
  path.join(os.homedir(), 'dev'),
  path.join(os.homedir(), 'projects'),
  path.join(os.homedir(), 'src'),
  path.join(os.homedir(), 'code'),
  path.join(os.homedir(), 'repos'),
];

/** Extract the GitHub "owner/repo" remote from a git directory */
function getGitHubRemote(repoPath: string): string | null {
  try {
    const remoteUrl = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Match HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
    const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];

    // Match SSH: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];

    return null;
  } catch {
    return null;
  }
}

/** Get the current branch of a git repo */
function getCurrentBranch(repoPath: string): string | null {
  try {
    return execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Scan directories for git repos, returning a map of owner/repo → local path */
export function scanForRepos(scanPaths: string[]): Record<string, LocalRepoInfo> {
  const repos: Record<string, LocalRepoInfo> = {};

  for (const scanPath of scanPaths) {
    if (!fs.existsSync(scanPath)) continue;

    // Find git repos up to 3 levels deep
    let gitDirs: string[];
    try {
      const output = execFileSync('find', [
        scanPath, '-maxdepth', '4', '-name', '.git', '-type', 'd',
      ], {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      gitDirs = output ? output.split('\n').filter(Boolean) : [];
    } catch {
      continue;
    }

    for (const gitDir of gitDirs) {
      const repoPath = path.dirname(gitDir);
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

export async function runLocalRepos(options: LocalReposOptions): Promise<void> {
  const stateManager = getStateManager();
  const state = stateManager.getState();
  const scanPaths = options.paths?.map(p => path.resolve(p)) ??
    state.config.localRepoScanPaths ??
    DEFAULT_SCAN_PATHS.filter(p => fs.existsSync(p));

  // Use cached data unless --scan is specified
  if (!options.scan && state.localRepoCache) {
    const cache = state.localRepoCache;
    const result: LocalReposOutput = {
      repos: cache.repos,
      scanPaths: cache.scanPaths,
      cachedAt: cache.cachedAt,
      fromCache: true,
    };

    if (options.json) {
      outputJson<LocalReposOutput>(result);
    } else {
      console.log(`\n📁 Local Repos (cached ${cache.cachedAt})\n`);
      printRepos(cache.repos);
    }
    return;
  }

  if (!options.json) {
    console.log(`\n🔍 Scanning for local repos in ${scanPaths.length} directories...\n`);
  }

  const repos = scanForRepos(scanPaths);
  const repoCount = Object.keys(repos).length;

  // Cache the results in state
  stateManager.setLocalRepoCache({
    repos,
    scanPaths,
    cachedAt: new Date().toISOString(),
  });
  stateManager.save();

  const result: LocalReposOutput = {
    repos,
    scanPaths,
    cachedAt: new Date().toISOString(),
    fromCache: false,
  };

  if (options.json) {
    outputJson<LocalReposOutput>(result);
  } else {
    console.log(`Found ${repoCount} repos:\n`);
    printRepos(repos);
  }
}

function printRepos(repos: Record<string, LocalRepoInfo>): void {
  const entries = Object.entries(repos).sort(([a], [b]) => a.localeCompare(b));
  for (const [remote, info] of entries) {
    const branch = info.currentBranch ? ` (${info.currentBranch})` : '';
    console.log(`  ${remote}${branch}`);
    console.log(`    ${info.path}`);
  }
}
