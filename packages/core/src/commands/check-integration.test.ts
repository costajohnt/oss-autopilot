/**
 * Tests for check-integration command (#83)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../core/index.js', () => ({
  debug: vi.fn(),
}));

// Must import after mocking
import { runCheckIntegration } from './check-integration.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('check-integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty result when git diff returns empty', async () => {
    mockExecFileSync.mockReturnValueOnce(''); // git diff --name-only

    const result = await runCheckIntegration({ base: 'main' });
    expect(result).toEqual({ newFiles: [], unreferencedCount: 0 });
  });

  it('should detect integrated files that are referenced', async () => {
    // git diff: new files
    mockExecFileSync.mockReturnValueOnce('src/commands/new-feature.ts\n');
    // git ls-files
    mockExecFileSync.mockReturnValueOnce('src/cli.ts\nsrc/commands/new-feature.ts\nsrc/core/index.ts\n');
    // git grep for "new-feature"
    mockExecFileSync.mockReturnValueOnce('src/cli.ts\n');
    // git grep for path-based import
    mockExecFileSync.mockReturnValueOnce('src/cli.ts\n');

    const result = await runCheckIntegration({ base: 'main' });

    expect(result.unreferencedCount).toBe(0);
    expect(result.newFiles).toHaveLength(1);
    expect(result.newFiles[0].isIntegrated).toBe(true);
  });

  it('should detect unreferenced files', async () => {
    // git diff: new files
    mockExecFileSync.mockReturnValueOnce('src/helpers/orphan.ts\n');
    // git ls-files
    mockExecFileSync.mockReturnValueOnce('src/cli.ts\nsrc/helpers/orphan.ts\nsrc/helpers/index.ts\n');
    // git grep for "orphan" -- throws (exit code 1 = no matches)
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'diff') return 'src/helpers/orphan.ts\n';
      if (argsArr[0] === 'ls-files') return 'src/cli.ts\nsrc/helpers/orphan.ts\nsrc/helpers/index.ts\n';
      if (argsArr[0] === 'grep') throw new Error('exit code 1');
      return '';
    });

    const result = await runCheckIntegration({ base: 'main' });

    expect(result.unreferencedCount).toBe(1);
  });

  it('should skip test files', async () => {
    mockExecFileSync.mockReturnValueOnce('src/core/new.test.ts\nsrc/core/new.spec.ts\n');

    const result = await runCheckIntegration({ base: 'main' });
    expect(result).toEqual({ newFiles: [], unreferencedCount: 0 });
  });

  it('should skip non-code files', async () => {
    mockExecFileSync.mockReturnValueOnce('README.md\npackage.json\ntsconfig.json\n');

    const result = await runCheckIntegration({ base: 'main' });
    expect(result).toEqual({ newFiles: [], unreferencedCount: 0 });
  });

  it('should throw error when git diff fails', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('git diff failed');
    });

    await expect(runCheckIntegration({ base: 'main' })).rejects.toThrow('Failed to run git diff');
  });
});
