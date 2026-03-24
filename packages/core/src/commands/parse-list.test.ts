/**
 * Tests for parse-issue-list command (#82)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseIssueList, pruneIssueList, runParseList } from './parse-list.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import * as fs from 'fs';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

describe('parseIssueList', () => {
  it('should parse basic issue list with URLs', () => {
    const content = `# Pursue
- https://github.com/owner/repo/issues/804 Add feature X
- https://github.com/other/lib/issues/42 Fix bug Y
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(2);
    expect(result.completedCount).toBe(0);
    expect(result.available[0]).toEqual({
      repo: 'owner/repo',
      number: 804,
      title: 'Add feature X',
      tier: 'Pursue',
      url: 'https://github.com/owner/repo/issues/804',
    });
    expect(result.available[1].repo).toBe('other/lib');
  });

  it('should detect strikethrough as completed', () => {
    const content = `# Done
- ~~https://github.com/owner/repo/issues/790 Fix bug Y~~
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(0);
    expect(result.completedCount).toBe(1);
    expect(result.completed[0].number).toBe(790);
  });

  it('should detect checked checkbox as completed', () => {
    const content = `# Tasks
- [x] https://github.com/owner/repo/issues/10 First task
- [ ] https://github.com/owner/repo/issues/11 Second task
`;
    const result = parseIssueList(content);
    expect(result.completedCount).toBe(1);
    expect(result.availableCount).toBe(1);
    expect(result.completed[0].number).toBe(10);
    expect(result.available[0].number).toBe(11);
  });

  it('should detect "Done" marker as completed', () => {
    const content = `# Tier 1
- https://github.com/owner/repo/issues/5 Feature A - Done
`;
    const result = parseIssueList(content);
    expect(result.completedCount).toBe(1);
    expect(result.completed[0].number).toBe(5);
  });

  it('should detect lowercase "done" marker as completed', () => {
    const content = `# Tier 1
- https://github.com/owner/repo/issues/6 Feature B - done
`;
    const result = parseIssueList(content);
    expect(result.completedCount).toBe(1);
    expect(result.availableCount).toBe(0);
  });

  it('should use section headings as tiers', () => {
    const content = `# High Priority
- https://github.com/a/b/issues/1 Issue one

## Low Priority
- https://github.com/c/d/issues/2 Issue two
`;
    const result = parseIssueList(content);
    expect(result.available[0].tier).toBe('High Priority');
    expect(result.available[1].tier).toBe('Low Priority');
  });

  it('should default tier to Uncategorized when no heading', () => {
    const content = `- https://github.com/a/b/issues/1 Issue one
`;
    const result = parseIssueList(content);
    expect(result.available[0].tier).toBe('Uncategorized');
  });

  it('should handle markdown link syntax', () => {
    const content = `# Issues
- [Add feature X](https://github.com/owner/repo/issues/804)
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(1);
    expect(result.available[0].title).toBe('Add feature X');
    expect(result.available[0].number).toBe(804);
  });

  it('should handle PR URLs alongside issue URLs', () => {
    const content = `# PRs
- https://github.com/owner/repo/pull/42 My PR
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(1);
    expect(result.available[0].number).toBe(42);
    expect(result.available[0].url).toBe('https://github.com/owner/repo/pull/42');
  });

  it('should skip lines without GitHub URLs', () => {
    const content = `# Notes
- This is just a note
- Some random text
- https://github.com/owner/repo/issues/1 Real issue
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(1);
    expect(result.available[0].number).toBe(1);
  });

  it('should handle empty input', () => {
    const result = parseIssueList('');
    expect(result.availableCount).toBe(0);
    expect(result.completedCount).toBe(0);
    expect(result.available).toEqual([]);
    expect(result.completed).toEqual([]);
  });

  it('should handle multiple tiers with mixed available/completed', () => {
    const content = `# Tier 1: Pursue
- https://github.com/a/b/issues/1 Available item
- ~~https://github.com/a/b/issues/2 Completed item~~

# Tier 2: Maybe
- https://github.com/c/d/issues/3 Another available
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(2);
    expect(result.completedCount).toBe(1);
    expect(result.available[0].tier).toBe('Tier 1: Pursue');
    expect(result.completed[0].tier).toBe('Tier 1: Pursue');
    expect(result.available[1].tier).toBe('Tier 2: Maybe');
  });

  it('should handle numbered lists', () => {
    const content = `# Issues
1. https://github.com/a/b/issues/1 First
2. https://github.com/a/b/issues/2 Second
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(2);
    expect(result.available[0].number).toBe(1);
    expect(result.available[1].number).toBe(2);
  });

  it('should use issue number as title when no title text found', () => {
    const content = `# Issues
- https://github.com/a/b/issues/99
`;
    const result = parseIssueList(content);
    expect(result.available[0].title).toBe('#99');
  });

  it('should handle uppercase [X] checkbox', () => {
    const content = `# Tasks
- [X] https://github.com/a/b/issues/1 Done task
`;
    const result = parseIssueList(content);
    expect(result.completedCount).toBe(1);
  });
});

describe('runParseList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw error when file not found', async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(runParseList({ filePath: 'nonexistent.md' })).rejects.toThrow('File not found');
  });

  it('should parse file and return result', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`# Issues
- https://github.com/a/b/issues/1 Available
- ~~https://github.com/a/b/issues/2 Done~~
`);

    const result = await runParseList({ filePath: 'issues.md' });

    expect(result).toEqual(expect.objectContaining({ availableCount: 1, completedCount: 1 }));
  });

  it('should throw error on read failure', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    await expect(runParseList({ filePath: 'issues.md' })).rejects.toThrow('Failed to read');
  });
});

describe('parseIssueList — score extraction', () => {
  it('extracts score from sub-bullet', () => {
    const content = `### Repo
- [#1](https://github.com/owner/repo/issues/1) — Fix bug
  - **Maybe** — Score 8/10. Good issue.`;
    const result = parseIssueList(content);
    expect(result.available[0].score).toBe(8);
  });

  it('extracts decimal score', () => {
    const content = `- [#1](https://github.com/owner/repo/issues/1) — Fix bug
  - Score 7.5/10`;
    const result = parseIssueList(content);
    expect(result.available[0].score).toBe(7.5);
  });

  it('leaves score undefined when no sub-bullet score', () => {
    const content = `- [#1](https://github.com/owner/repo/issues/1) — Fix bug`;
    const result = parseIssueList(content);
    expect(result.available[0].score).toBeUndefined();
  });
});

describe('parseIssueList — sub-bullet status detection', () => {
  it('moves Skip items to completed', () => {
    const content = `- [#1](https://github.com/owner/repo/issues/1) — Fix bug
  - **Skip** — Score 3/10. Existing PR.`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].number).toBe(1);
  });

  it('moves Merged items to completed', () => {
    const content = `- [#1](https://github.com/owner/repo/issues/1) — Fix bug
  - **Merged** — PR merged.`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
  });

  it('moves In Progress items to completed (not available) but they are NOT terminal', () => {
    const content = `- [#1](https://github.com/owner/repo/issues/1) — Fix bug
  - **In Progress** — Working on it.`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
  });

  it('keeps Maybe items as available', () => {
    const content = `- [#1](https://github.com/owner/repo/issues/1) — Fix bug
  - **Maybe** — Score 8/10. Looks good.`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(1);
    expect(result.completed).toHaveLength(0);
  });
});

describe('pruneIssueList', () => {
  it('removes strikethrough items', () => {
    const content = `### Repo
- ~~[#1](https://github.com/owner/repo/issues/1) — Done~~
- [#2](https://github.com/owner/repo/issues/2) — Active
  - **Maybe** — Score 8/10
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(1);
    expect(pruned).not.toContain('#1');
    expect(pruned).toContain('#2');
  });

  it('removes items with terminal sub-bullet status', () => {
    const content = `### Repo
- [#1](https://github.com/owner/repo/issues/1) — Fix bug
  - **Skip** — Score 3/10.
- [#2](https://github.com/owner/repo/issues/2) — Active
  - **Maybe** — Score 8/10
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(1);
    expect(pruned).not.toContain('#1');
    expect(pruned).toContain('#2');
  });

  it('removes items with score below threshold', () => {
    const content = `- [#1](https://github.com/owner/repo/issues/1) — Low score
  - Score 4/10
- [#2](https://github.com/owner/repo/issues/2) — High score
  - Score 8/10
`;
    const { pruned } = pruneIssueList(content, 6);
    expect(pruned).not.toContain('#1');
    expect(pruned).toContain('#2');
  });

  it('preserves In Progress items (not terminal)', () => {
    const content = `### Repo
- [#1](https://github.com/owner/repo/issues/1) — Working on it
  - **In Progress** — Draft PR open.
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(0);
    expect(pruned).toContain('#1');
  });

  it('preserves Waiting items (not terminal)', () => {
    const content = `### Repo
- [#1](https://github.com/owner/repo/issues/1) — Waiting for response
  - **Waiting** — Asked maintainer.
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(0);
    expect(pruned).toContain('#1');
  });

  it('removes empty section headings', () => {
    const content = `### Empty Section
- ~~[#1](https://github.com/owner/repo/issues/1) — Done~~

### Active Section
- [#2](https://github.com/owner/repo/issues/2) — Active
  - Score 8/10
`;
    const { pruned } = pruneIssueList(content);
    expect(pruned).not.toContain('Empty Section');
    expect(pruned).toContain('Active Section');
  });

  it('collapses consecutive blank lines', () => {
    const content = `### Repo
- [#1](https://github.com/owner/repo/issues/1) — Active
  - Score 8/10



`;
    const { pruned } = pruneIssueList(content);
    expect(pruned).not.toContain('\n\n\n');
  });

  it('removes strikethrough list items without URLs', () => {
    const content = `### Repo
- ~~Some completed task~~
- [#1](https://github.com/owner/repo/issues/1) — Active
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(1);
    expect(pruned).not.toContain('completed task');
    expect(pruned).toContain('#1');
  });
});
