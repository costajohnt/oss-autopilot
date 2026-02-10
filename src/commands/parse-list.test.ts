/**
 * Tests for parse-issue-list command (#82)
 */

import { describe, it, expect } from 'vitest';
import { parseIssueList } from './parse-list.js';

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
