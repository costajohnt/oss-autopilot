/**
 * Tests for skip-add.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runSkipAdd } from './skip-add.js';

const mockGetStateManager = vi.mocked(getStateManager);

function stateManagerWithPath(skippedIssuesPath: string | undefined) {
  return {
    getState: () => ({ config: { skippedIssuesPath } }),
  } as unknown as ReturnType<typeof getStateManager>;
}

describe('runSkipAdd', () => {
  let tmpDir: string;
  let skipFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-add-'));
    skipFile = path.join(tmpDir, 'skipped-issues.md');
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the file with the standard header when it does not exist', () => {
    const result = runSkipAdd({
      issueUrl: 'https://github.com/foo/bar/issues/1',
      skipFilePath: skipFile,
      now: new Date('2026-04-19T12:00:00Z'),
    });

    const contents = fs.readFileSync(skipFile, 'utf-8');
    expect(contents).toContain('# Skipped Issues — auto-culled after 90 days');
    expect(contents).toContain('# Format: YYYY-MM-DD URL');
    expect(contents).toContain('2026-04-19 https://github.com/foo/bar/issues/1');
    expect(result).toEqual({
      added: true,
      alreadyPresent: false,
      url: 'https://github.com/foo/bar/issues/1',
      path: skipFile,
      date: '2026-04-19',
    });
  });

  it('appends to an existing file without duplicating the header', () => {
    fs.writeFileSync(
      skipFile,
      '# Skipped Issues — auto-culled after 90 days\n# Format: YYYY-MM-DD URL\n\n2026-04-15 https://github.com/owner/repo/issues/99\n',
    );

    runSkipAdd({
      issueUrl: 'https://github.com/foo/bar/issues/1',
      skipFilePath: skipFile,
      now: new Date('2026-04-19T00:00:00Z'),
    });

    const contents = fs.readFileSync(skipFile, 'utf-8');
    const headerOccurrences = contents.split('# Skipped Issues').length - 1;
    expect(headerOccurrences).toBe(1);
    expect(contents).toContain('2026-04-15 https://github.com/owner/repo/issues/99');
    expect(contents).toContain('2026-04-19 https://github.com/foo/bar/issues/1');
  });

  it('is a no-op when the URL is already present (idempotent)', () => {
    fs.writeFileSync(
      skipFile,
      '# Skipped Issues — auto-culled after 90 days\n# Format: YYYY-MM-DD URL\n\n2026-04-15 https://github.com/foo/bar/issues/1\n',
    );
    const before = fs.readFileSync(skipFile, 'utf-8');

    const result = runSkipAdd({
      issueUrl: 'https://github.com/foo/bar/issues/1',
      skipFilePath: skipFile,
      now: new Date('2026-04-19T00:00:00Z'),
    });

    const after = fs.readFileSync(skipFile, 'utf-8');
    expect(after).toBe(before);
    expect(result).toEqual({
      added: false,
      alreadyPresent: true,
      url: 'https://github.com/foo/bar/issues/1',
      path: skipFile,
    });
  });

  it('accepts PR URLs (matches skip-file-parser semantics)', () => {
    const result = runSkipAdd({
      issueUrl: 'https://github.com/foo/bar/pull/42',
      skipFilePath: skipFile,
      now: new Date('2026-04-19T00:00:00Z'),
    });

    expect(result.added).toBe(true);
    const contents = fs.readFileSync(skipFile, 'utf-8');
    expect(contents).toContain('2026-04-19 https://github.com/foo/bar/pull/42');
  });

  it('rejects non-GitHub URLs', () => {
    expect(() =>
      runSkipAdd({
        issueUrl: 'https://gitlab.com/foo/bar/issues/1',
        skipFilePath: skipFile,
      }),
    ).toThrow(/Invalid GitHub issue or PR URL/);
    expect(fs.existsSync(skipFile)).toBe(false);
  });

  it('rejects malformed URLs (missing issue number)', () => {
    expect(() =>
      runSkipAdd({
        issueUrl: 'https://github.com/foo/bar/issues/',
        skipFilePath: skipFile,
      }),
    ).toThrow(/Invalid GitHub issue or PR URL/);
  });

  it('falls back to config.skippedIssuesPath when skipFilePath is omitted', () => {
    mockGetStateManager.mockReturnValue(stateManagerWithPath(skipFile));

    const result = runSkipAdd({
      issueUrl: 'https://github.com/foo/bar/issues/7',
      now: new Date('2026-04-19T00:00:00Z'),
    });

    expect(result.added).toBe(true);
    expect(result.path).toBe(skipFile);
    const contents = fs.readFileSync(skipFile, 'utf-8');
    expect(contents).toContain('2026-04-19 https://github.com/foo/bar/issues/7');
  });

  it('throws when no path can be resolved', () => {
    mockGetStateManager.mockReturnValue(stateManagerWithPath(undefined));

    expect(() => runSkipAdd({ issueUrl: 'https://github.com/foo/bar/issues/1' })).toThrow(
      /No skipped-issues path configured/,
    );
  });

  it('uses UTC for the date (not local time)', () => {
    runSkipAdd({
      issueUrl: 'https://github.com/foo/bar/issues/1',
      skipFilePath: skipFile,
      // 23:30 UTC on Apr 19 is already Apr 19 UTC — cross-check with a
      // TZ-sensitive moment: 01:30 UTC on Apr 20 would be Apr 19 in PDT.
      now: new Date('2026-04-20T01:30:00Z'),
    });

    const contents = fs.readFileSync(skipFile, 'utf-8');
    expect(contents).toContain('2026-04-20 https://github.com/foo/bar/issues/1');
    expect(contents).not.toContain('2026-04-19 https://github.com/foo/bar/issues/1');
  });
});
