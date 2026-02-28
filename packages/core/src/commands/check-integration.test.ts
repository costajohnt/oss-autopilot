/**
 * Tests for check-integration command (#83)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// Must import after mocking
import { runCheckIntegration } from './check-integration.js';

const mockExecFileSync = vi.mocked(execFileSync);

describe('check-integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should report no new files when git diff returns empty', async () => {
    mockExecFileSync.mockReturnValueOnce(''); // git diff --name-only

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCheckIntegration({ base: 'main', json: false });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No new code files'));
    consoleSpy.mockRestore();
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

    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      if (typeof msg === 'string') output.push(msg);
    });

    await runCheckIntegration({ base: 'main', json: false });

    const allOutput = output.join('\n');
    expect(allOutput).toContain('Unreferenced: 0');
    consoleSpy.mockRestore();
  });

  it('should detect unreferenced files', async () => {
    // git diff: new files
    mockExecFileSync.mockReturnValueOnce('src/helpers/orphan.ts\n');
    // git ls-files
    mockExecFileSync.mockReturnValueOnce('src/cli.ts\nsrc/helpers/orphan.ts\nsrc/helpers/index.ts\n');
    // git grep for "orphan" — throws (exit code 1 = no matches)
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === 'diff') return 'src/helpers/orphan.ts\n';
      if (argsArr[0] === 'ls-files') return 'src/cli.ts\nsrc/helpers/orphan.ts\nsrc/helpers/index.ts\n';
      if (argsArr[0] === 'grep') throw new Error('exit code 1');
      return '';
    });

    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      if (typeof msg === 'string') output.push(msg);
    });

    await runCheckIntegration({ base: 'main', json: false });

    const allOutput = output.join('\n');
    expect(allOutput).toContain('Unreferenced: 1');
    consoleSpy.mockRestore();
  });

  it('should skip test files', async () => {
    mockExecFileSync.mockReturnValueOnce('src/core/new.test.ts\nsrc/core/new.spec.ts\n');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCheckIntegration({ base: 'main', json: false });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No new code files'));
    consoleSpy.mockRestore();
  });

  it('should skip non-code files', async () => {
    mockExecFileSync.mockReturnValueOnce('README.md\npackage.json\ntsconfig.json\n');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCheckIntegration({ base: 'main', json: false });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No new code files'));
    consoleSpy.mockRestore();
  });

  it('should output JSON when --json is specified', async () => {
    mockExecFileSync.mockReturnValueOnce(''); // git diff

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCheckIntegration({ base: 'main', json: true });

    const jsonCall = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(jsonCall);
    expect(parsed.success).toBe(true);
    expect(parsed.data.newFiles).toEqual([]);
    expect(parsed.data.unreferencedCount).toBe(0);
    consoleSpy.mockRestore();
  });
});
