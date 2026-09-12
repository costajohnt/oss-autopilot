/**
 * Tests for local-repos command (#84)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  debug: vi.fn(),
}));

import { scanForRepos, runLocalRepos } from './local-repos.js';
import { getStateManager } from '../core/index.js';
import * as fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);

function directoryEntry(name: string, isDirectory = true): fs.Dirent {
  return { name, isDirectory: () => isDirectory } as fs.Dirent;
}

function mockDirectoryTree(tree: Record<string, fs.Dirent[] | { error: Error }>): void {
  mockReaddirSync.mockImplementation(((directory: fs.PathLike) => {
    const result = tree[String(directory)] ?? [];
    if (!Array.isArray(result)) throw result.error;
    return result;
  }) as never);
}

describe('scanForRepos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaddirSync.mockReturnValue([] as never);
  });

  it('should return empty map when no scan paths exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = scanForRepos(['/nonexistent']);
    expect(result).toEqual({});
  });

  it('should discover repos in scan paths', () => {
    mockExistsSync.mockReturnValue(true);
    const root = path.join('home', 'user', 'dev');
    const repo = path.join(root, 'my-project');
    mockDirectoryTree({
      [root]: [directoryEntry('my-project')],
      [repo]: [directoryEntry('.git')],
    });

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'git' && argsArr.includes('get-url')) {
        return 'https://github.com/owner/my-project.git\n';
      }
      if (cmd === 'git' && argsArr.includes('--show-current')) {
        return 'main\n';
      }
      return '';
    });

    const result = scanForRepos([root]);
    expect(result['owner/my-project']).toEqual({
      path: repo,
      exists: true,
      currentBranch: 'main',
    });
  });

  it('should handle SSH remote URLs', () => {
    mockExistsSync.mockReturnValue(true);
    const root = path.join('home', 'user', 'dev');
    const repo = path.join(root, 'project');
    mockDirectoryTree({
      [root]: [directoryEntry('project')],
      [repo]: [directoryEntry('.git')],
    });

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'git' && argsArr.includes('get-url')) {
        return 'git@github.com:owner/project.git\n';
      }
      if (cmd === 'git' && argsArr.includes('--show-current')) {
        return 'feature-branch\n';
      }
      return '';
    });

    const result = scanForRepos([root]);
    expect(result['owner/project']).toBeDefined();
    expect(result['owner/project'].currentBranch).toBe('feature-branch');
  });

  it('should skip repos without GitHub remotes', () => {
    mockExistsSync.mockReturnValue(true);
    const root = path.join('home', 'user', 'dev');
    const repo = path.join(root, 'local-only');
    mockDirectoryTree({
      [root]: [directoryEntry('local-only')],
      [repo]: [directoryEntry('.git')],
    });

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'git' && argsArr.includes('get-url')) {
        return 'https://gitlab.com/owner/local-only.git\n';
      }
      return '';
    });

    const result = scanForRepos([root]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('should scan multiple paths and deduplicate', () => {
    mockExistsSync.mockReturnValue(true);
    const rootA = path.join('scan', 'one');
    const rootB = path.join('scan', 'two');
    const repoA = path.join(rootA, 'repo-a');
    const repoB = path.join(rootB, 'repo-b');
    mockDirectoryTree({
      [rootA]: [directoryEntry('repo-a')],
      [repoA]: [directoryEntry('.git')],
      [rootB]: [directoryEntry('repo-b')],
      [repoB]: [directoryEntry('.git')],
    });

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'git' && argsArr.includes('get-url')) {
        if (argsArr.includes(repoA)) {
          return 'https://github.com/owner/repo-a.git\n';
        }
        return 'https://github.com/owner/repo-b.git\n';
      }
      if (cmd === 'git' && argsArr.includes('--show-current')) {
        return 'main\n';
      }
      return '';
    });

    const result = scanForRepos([rootA, rootB]);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result['owner/repo-a']).toBeDefined();
    expect(result['owner/repo-b']).toBeDefined();
  });

  it('should handle HTTPS URLs without .git suffix', () => {
    mockExistsSync.mockReturnValue(true);
    const root = path.join('home', 'user', 'dev');
    const repo = path.join(root, 'repo');
    mockDirectoryTree({
      [root]: [directoryEntry('repo')],
      [repo]: [directoryEntry('.git')],
    });

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'git' && argsArr.includes('get-url')) {
        return 'https://github.com/owner/repo\n';
      }
      if (cmd === 'git' && argsArr.includes('--show-current')) {
        return 'main\n';
      }
      return '';
    });

    const result = scanForRepos([root]);
    expect(result['owner/repo']).toBeDefined();
  });

  it('should handle git remote failure gracefully', () => {
    mockExistsSync.mockReturnValue(true);
    const root = path.join('home', 'user', 'dev');
    const repo = path.join(root, 'repo');
    mockDirectoryTree({
      [root]: [directoryEntry('repo')],
      [repo]: [directoryEntry('.git')],
    });

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'git' && argsArr.includes('get-url')) {
        throw new Error('remote not found');
      }
      return '';
    });

    const result = scanForRepos([root]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('should handle git branch failure gracefully', () => {
    mockExistsSync.mockReturnValue(true);
    const root = path.join('home', 'user', 'dev');
    const repo = path.join(root, 'repo');
    mockDirectoryTree({
      [root]: [directoryEntry('repo')],
      [repo]: [directoryEntry('.git')],
    });

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'git' && argsArr.includes('get-url')) {
        return 'https://github.com/owner/repo.git\n';
      }
      if (cmd === 'git' && argsArr.includes('--show-current')) {
        throw new Error('detached HEAD');
      }
      return '';
    });

    const result = scanForRepos([root]);
    expect(result['owner/repo']).toBeDefined();
    expect(result['owner/repo'].currentBranch).toBeNull();
  });
});

describe('scanForRepos directory traversal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([] as never);
  });

  it('should handle an unreadable scan path gracefully', () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const result = scanForRepos(['/home/user/dev']);
    expect(result).toEqual({});
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('should continue scanning when a nested directory is unreadable', () => {
    const root = path.join('home', 'user', 'dev');
    const blocked = path.join(root, 'blocked');
    const repo = path.join(root, 'repo');
    mockDirectoryTree({
      [root]: [directoryEntry('blocked'), directoryEntry('repo')],
      [blocked]: { error: new Error('permission denied') },
      [repo]: [directoryEntry('.git')],
    });
    mockExecFileSync.mockImplementation((command, parameters) => {
      const parameterArray = parameters as string[];
      if (command === 'git' && parameterArray.includes('get-url')) {
        return 'https://github.com/owner/repo.git\n';
      }
      if (command === 'git' && parameterArray.includes('--show-current')) return 'main\n';
      return '';
    });

    const result = scanForRepos([root]);
    expect(result['owner/repo']?.path).toBe(repo);
  });

  it('should not scan beyond the existing maximum depth', () => {
    const root = path.join('scan', 'root');
    const level1 = path.join(root, 'one');
    const level2 = path.join(level1, 'two');
    const level3 = path.join(level2, 'three');
    const tooDeepRepo = path.join(level3, 'repo');
    mockDirectoryTree({
      [root]: [directoryEntry('one')],
      [level1]: [directoryEntry('two')],
      [level2]: [directoryEntry('three')],
      [level3]: [directoryEntry('repo')],
      [tooDeepRepo]: [directoryEntry('.git')],
    });

    const result = scanForRepos([root]);
    expect(result).toEqual({});
    expect(mockReaddirSync).not.toHaveBeenCalledWith(tooDeepRepo, expect.anything());
  });

  it('should find a .git directory at exactly the maximum depth', () => {
    const root = path.join('scan', 'root');
    const level1 = path.join(root, 'one');
    const level2 = path.join(level1, 'two');
    const repo = path.join(level2, 'repo');
    mockDirectoryTree({
      [root]: [directoryEntry('one')],
      [level1]: [directoryEntry('two')],
      [level2]: [directoryEntry('repo')],
      [repo]: [directoryEntry('.git')],
    });
    mockExecFileSync.mockImplementation((command, parameters) => {
      const parameterArray = parameters as string[];
      if (command === 'git' && parameterArray.includes('get-url')) {
        return 'https://github.com/owner/deep.git\n';
      }
      if (command === 'git' && parameterArray.includes('--show-current')) return 'main\n';
      return '';
    });

    const result = scanForRepos([root]);
    expect(result['owner/deep']?.path).toBe(repo);
  });

  it('should skip non-directory entries (files and symlinks, which readdirSync does not follow)', () => {
    const root = path.join('scan', 'root');
    mockDirectoryTree({
      [root]: [directoryEntry('linked-repo', false)],
    });

    const result = scanForRepos([root]);
    expect(result).toEqual({});
    expect(mockReaddirSync).toHaveBeenCalledTimes(1);
  });

  it('should stop with partial results once the scan deadline passes', () => {
    vi.useFakeTimers();
    try {
      const root = path.join('scan', 'root');
      const slow = path.join(root, 'slow');
      const never = path.join(root, 'never');
      mockReaddirSync.mockImplementation(((directory: fs.PathLike) => {
        if (String(directory) === root) return [directoryEntry('slow'), directoryEntry('never')];
        // Reading the first child takes longer than the whole budget.
        vi.advanceTimersByTime(31_000);
        return [];
      }) as never);

      const result = scanForRepos([root]);
      expect(result).toEqual({});
      expect(mockReaddirSync).toHaveBeenCalledTimes(2);
      expect(mockReaddirSync).not.toHaveBeenCalledWith(slow, expect.anything());
      expect(mockReaddirSync).toHaveBeenCalledWith(never, expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});

const mockGetStateManager = vi.mocked(getStateManager);

describe('runLocalRepos', () => {
  const mockSave = vi.fn();
  const mockSetLocalRepoCache = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({ config: {}, localRepoCache: null }),
      setLocalRepoCache: mockSetLocalRepoCache,
      save: mockSave,
    } as any);
    mockExistsSync.mockReturnValue(false);
  });

  it('should return cached data when available and not scanning', async () => {
    const cachedRepos = { 'owner/repo': { path: '/dev/repo', exists: true, currentBranch: 'main' } };
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({
        config: {},
        localRepoCache: { repos: cachedRepos, scanPaths: ['/dev'], cachedAt: '2026-01-01T00:00:00Z' },
      }),
      save: mockSave,
    } as any);

    const result = await runLocalRepos({});

    expect(result).toEqual(expect.objectContaining({ fromCache: true, repos: cachedRepos }));
  });

  it('should scan when --scan is specified even if cache exists', async () => {
    mockGetStateManager.mockReturnValue({
      getState: vi.fn().mockReturnValue({
        config: {},
        localRepoCache: { repos: {}, scanPaths: ['/dev'], cachedAt: '2026-01-01T00:00:00Z' },
      }),
      setLocalRepoCache: mockSetLocalRepoCache,
      save: mockSave,
    } as any);

    const result = await runLocalRepos({ scan: true, paths: ['/nonexistent'] });

    expect(result).toEqual(expect.objectContaining({ fromCache: false }));
  });

  it('should handle cache save failure gracefully', async () => {
    mockSetLocalRepoCache.mockImplementation(() => {
      throw new Error('Write failed');
    });

    const result = await runLocalRepos({ scan: true, paths: ['/nonexistent'] });

    // Cache failure is logged via debug(), result still returned successfully
    expect(result.fromCache).toBe(false);
  });
});
