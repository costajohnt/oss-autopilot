/**
 * Tests for local-repos command (#84)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

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
  };
});

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);

describe('scanForRepos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty map when no scan paths exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = scanForRepos(['/nonexistent']);
    expect(result).toEqual({});
  });

  it('should discover repos in scan paths', () => {
    mockExistsSync.mockReturnValue(true);

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'find') {
        return '/home/user/dev/my-project/.git\n';
      }
      if (cmd === 'git' && argsArr.includes('get-url')) {
        return 'https://github.com/owner/my-project.git\n';
      }
      if (cmd === 'git' && argsArr.includes('--show-current')) {
        return 'main\n';
      }
      return '';
    });

    const result = scanForRepos(['/home/user/dev']);
    expect(result['owner/my-project']).toEqual({
      path: '/home/user/dev/my-project',
      exists: true,
      currentBranch: 'main',
    });
  });

  it('should handle SSH remote URLs', () => {
    mockExistsSync.mockReturnValue(true);

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'find') {
        return '/home/user/dev/project/.git\n';
      }
      if (cmd === 'git' && argsArr.includes('get-url')) {
        return 'git@github.com:owner/project.git\n';
      }
      if (cmd === 'git' && argsArr.includes('--show-current')) {
        return 'feature-branch\n';
      }
      return '';
    });

    const result = scanForRepos(['/home/user/dev']);
    expect(result['owner/project']).toBeDefined();
    expect(result['owner/project'].currentBranch).toBe('feature-branch');
  });

  it('should skip repos without GitHub remotes', () => {
    mockExistsSync.mockReturnValue(true);

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'find') {
        return '/home/user/dev/local-only/.git\n';
      }
      if (cmd === 'git' && argsArr.includes('get-url')) {
        return 'https://gitlab.com/owner/local-only.git\n';
      }
      return '';
    });

    const result = scanForRepos(['/home/user/dev']);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('should scan multiple paths and deduplicate', () => {
    mockExistsSync.mockReturnValue(true);

    let callCount = 0;
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'find') {
        callCount++;
        if (callCount === 1) return '/path1/repo-a/.git\n';
        return '/path2/repo-b/.git\n';
      }
      if (cmd === 'git' && argsArr.includes('get-url')) {
        if (argsArr.includes('/path1/repo-a')) {
          return 'https://github.com/owner/repo-a.git\n';
        }
        return 'https://github.com/owner/repo-b.git\n';
      }
      if (cmd === 'git' && argsArr.includes('--show-current')) {
        return 'main\n';
      }
      return '';
    });

    const result = scanForRepos(['/path1', '/path2']);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result['owner/repo-a']).toBeDefined();
    expect(result['owner/repo-b']).toBeDefined();
  });

  it('should handle find command failure gracefully', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('find failed');
    });

    const result = scanForRepos(['/home/user/dev']);
    expect(result).toEqual({});
  });

  it('should handle HTTPS URLs without .git suffix', () => {
    mockExistsSync.mockReturnValue(true);

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'find') {
        return '/home/user/dev/repo/.git\n';
      }
      if (cmd === 'git' && argsArr.includes('get-url')) {
        return 'https://github.com/owner/repo\n';
      }
      if (cmd === 'git' && argsArr.includes('--show-current')) {
        return 'main\n';
      }
      return '';
    });

    const result = scanForRepos(['/home/user/dev']);
    expect(result['owner/repo']).toBeDefined();
  });

  it('should handle git remote failure gracefully', () => {
    mockExistsSync.mockReturnValue(true);

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'find') {
        return '/home/user/dev/repo/.git\n';
      }
      if (cmd === 'git' && argsArr.includes('get-url')) {
        throw new Error('remote not found');
      }
      return '';
    });

    const result = scanForRepos(['/home/user/dev']);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('should handle git branch failure gracefully', () => {
    mockExistsSync.mockReturnValue(true);

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'find') {
        return '/home/user/dev/repo/.git\n';
      }
      if (cmd === 'git' && argsArr.includes('get-url')) {
        return 'https://github.com/owner/repo.git\n';
      }
      if (cmd === 'git' && argsArr.includes('--show-current')) {
        throw new Error('detached HEAD');
      }
      return '';
    });

    const result = scanForRepos(['/home/user/dev']);
    expect(result['owner/repo']).toBeDefined();
    expect(result['owner/repo'].currentBranch).toBeNull();
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
