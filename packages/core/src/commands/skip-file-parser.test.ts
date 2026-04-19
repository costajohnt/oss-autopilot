/**
 * Tests for skip-file-parser (#989)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('../core/logger.js', () => ({
  warn: vi.fn(),
}));

import * as fs from 'fs';
import { warn } from '../core/logger.js';
import { parseSkippedIssuesContent, loadSkippedIssues } from './skip-file-parser.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWarn = vi.mocked(warn);

describe('parseSkippedIssuesContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return [] for an empty file', () => {
    expect(parseSkippedIssuesContent('')).toEqual([]);
  });

  it('should return [] for a comment-only file', () => {
    const content = `# Skipped Issues — auto-culled after 90 days
# Format: YYYY-MM-DD URL

`;
    expect(parseSkippedIssuesContent(content)).toEqual([]);
  });

  it('should parse valid date + URL entries into SkippedIssue[]', () => {
    const content = `# Skipped Issues — auto-culled after 90 days
# Format: YYYY-MM-DD URL

2026-04-15 https://github.com/owncast/owncast/issues/4883
2026-04-19 https://github.com/super-productivity/super-productivity/issues/7271
`;
    const result = parseSkippedIssuesContent(content);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      url: 'https://github.com/owncast/owncast/issues/4883',
      repo: 'owncast/owncast',
      number: 4883,
      title: '',
      skippedAt: '2026-04-15T00:00:00.000Z',
    });
    expect(result[1]).toEqual({
      url: 'https://github.com/super-productivity/super-productivity/issues/7271',
      repo: 'super-productivity/super-productivity',
      number: 7271,
      title: '',
      skippedAt: '2026-04-19T00:00:00.000Z',
    });
  });

  it('should skip malformed lines, warn, and preserve surrounding valid entries', () => {
    const content = `# header
2026-04-15 https://github.com/owncast/owncast/issues/4883
not-a-valid-line
2026-13-99 https://github.com/owner/repo/issues/1
2026-04-19 not-a-url
2026-04-20 https://github.com/good/repo/issues/99
`;
    const result = parseSkippedIssuesContent(content);

    expect(result).toHaveLength(2);
    expect(result[0].url).toBe('https://github.com/owncast/owncast/issues/4883');
    expect(result[1].url).toBe('https://github.com/good/repo/issues/99');
    // At least one warning per malformed line
    expect(mockWarn).toHaveBeenCalled();
    const warnCalls = mockWarn.mock.calls.length;
    expect(warnCalls).toBeGreaterThanOrEqual(3);
  });

  it('should handle PR URLs as well as issue URLs', () => {
    const content = `2026-04-15 https://github.com/owner/repo/pull/42
`;
    const result = parseSkippedIssuesContent(content);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      url: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
      number: 42,
      title: '',
      skippedAt: '2026-04-15T00:00:00.000Z',
    });
  });

  it('should reject invalid calendar dates that JS would silently normalize', () => {
    // Date.parse('2026-02-30T00:00:00.000Z') silently rolls over to Mar 2.
    // Without a round-trip guard this entry would be stored under the wrong
    // date and scout's 90-day cull would fire against a shifted value.
    const content = `2026-02-30 https://github.com/owner/repo/issues/1
2026-02-29 https://github.com/owner/repo/issues/2
2026-04-15 https://github.com/good/repo/issues/99
`;
    const result = parseSkippedIssuesContent(content);

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://github.com/good/repo/issues/99');
    // Both invalid calendar dates must trigger a warning that includes the
    // normalized date so the user can find and fix them.
    const warnMessages = mockWarn.mock.calls.map((call) => call[1]);
    expect(warnMessages.some((m: unknown) => typeof m === 'string' && m.includes('2026-02-30'))).toBe(true);
    expect(warnMessages.some((m: unknown) => typeof m === 'string' && m.includes('2026-02-29'))).toBe(true);
  });

  it('should include 1-based line numbers in warnings', () => {
    const content = `# header
2026-04-15 https://github.com/good/repo/issues/1
not-a-valid-line
2026-04-16 https://github.com/good/repo/issues/2
`;
    parseSkippedIssuesContent(content);

    // The malformed line is line 3 (header is 1, first valid is 2).
    const warnMessages = mockWarn.mock.calls.map((call) => call[1]);
    expect(warnMessages.some((m: unknown) => typeof m === 'string' && m.includes('Line 3'))).toBe(true);
  });

  it('should tolerate blank lines between entries', () => {
    const content = `
2026-04-15 https://github.com/owner/repo/issues/1

2026-04-16 https://github.com/owner/repo/issues/2

`;
    const result = parseSkippedIssuesContent(content);
    expect(result).toHaveLength(2);
  });
});

describe('loadSkippedIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return [] when no path is configured', () => {
    const result = loadSkippedIssues(undefined);
    expect(result).toEqual([]);
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('should return [] when the path is an empty string', () => {
    const result = loadSkippedIssues('');
    expect(result).toEqual([]);
  });

  it('should return [] when the file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = loadSkippedIssues('/does/not/exist.md');
    expect(result).toEqual([]);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('should read and parse the file when it exists', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`# header
2026-04-15 https://github.com/owncast/owncast/issues/4883
`);

    const result = loadSkippedIssues('/real/path.md');

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://github.com/owncast/owncast/issues/4883');
    expect(mockReadFileSync).toHaveBeenCalledWith('/real/path.md', 'utf-8');
  });

  it('should return [] and warn if reading the file throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = loadSkippedIssues('/restricted/path.md');
    expect(result).toEqual([]);
    expect(mockWarn).toHaveBeenCalled();
  });
});
