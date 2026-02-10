/**
 * Tests for local-repos command (#84)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { scanForRepos } from './local-repos.js';
import * as fs from 'fs';

vi.mock('fs', async () => {
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
});
