/**
 * Tests for startup command helper functions
 */

import { describe, it, expect } from 'vitest';
import { parseIssueListPathFromConfig, countIssueListItems } from './startup.js';

describe('parseIssueListPathFromConfig', () => {
  it('should extract issueListPath from YAML frontmatter', () => {
    const config = `---
setupComplete: true
issueListPath: open-source/potential-issue-list.md
---

Some content here.
`;
    expect(parseIssueListPathFromConfig(config)).toBe('open-source/potential-issue-list.md');
  });

  it('should handle quoted paths', () => {
    const config = `---
issueListPath: "my issues/list.md"
---
`;
    expect(parseIssueListPathFromConfig(config)).toBe('my issues/list.md');
  });

  it('should handle single-quoted paths', () => {
    const config = `---
issueListPath: 'oss/issues.md'
---
`;
    expect(parseIssueListPathFromConfig(config)).toBe('oss/issues.md');
  });

  it('should return undefined when no frontmatter present', () => {
    const config = `Just some content without frontmatter.`;
    expect(parseIssueListPathFromConfig(config)).toBeUndefined();
  });

  it('should return undefined when issueListPath not in frontmatter', () => {
    const config = `---
setupComplete: true
username: testuser
---
`;
    expect(parseIssueListPathFromConfig(config)).toBeUndefined();
  });

  it('should handle empty frontmatter', () => {
    const config = `---
---
`;
    expect(parseIssueListPathFromConfig(config)).toBeUndefined();
  });

  it('should trim whitespace from path', () => {
    const config = `---
issueListPath:   path/with/spaces.md
---
`;
    expect(parseIssueListPathFromConfig(config)).toBe('path/with/spaces.md');
  });
});

describe('countIssueListItems', () => {
  it('should count available and completed items', () => {
    const content = `## Pursue — Ready to Contribute

### org/repo (500★) — Description
- [#123](https://github.com/org/repo/issues/123) — Fix bug
  - **Low complexity**

### ~~org/done (200★) — Done repo~~
- ~~[#456](https://github.com/org/done/issues/456) — Old issue~~
  - **Done** — PR #42 submitted

### org/another (300★)
- [#789](https://github.com/org/another/issues/789) — New feature
  - **Medium complexity**
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(2);
    expect(result.completedCount).toBe(1);
  });

  it('should return zeros for empty content', () => {
    const result = countIssueListItems('');
    expect(result.availableCount).toBe(0);
    expect(result.completedCount).toBe(0);
  });

  it('should return zeros for content with no list items', () => {
    const content = `## Some heading

Just some text, no issue list items.
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(0);
    expect(result.completedCount).toBe(0);
  });

  it('should detect strikethrough as completed', () => {
    const content = `- ~~[#1](url) — Done item~~
- [#2](url) — Active item
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(1);
  });

  it('should detect **Done** marker as completed', () => {
    const content = `- [#1](url) — Item with **Done** marker
- [#2](url) — Active item
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(1);
  });

  it('should handle indented list items', () => {
    const content = `  - [#1](url) — Indented available
  - ~~[#2](url) — Indented done~~
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(1);
  });

  it('should not count lines that do not start with - [', () => {
    const content = `- Some regular list item
- Another item
- [#1](url) — Real issue list item
  - Sub-item that starts with - [but is indented sub-bullet
`;
    const result = countIssueListItems(content);
    // Only "- [#1]" matches — "  - Sub-item..." has "S" not "[" after "- "
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(0);
  });

  it('should handle mixed available and completed items', () => {
    const content = `- [#1](url) — Available 1
- ~~[#2](url) — Done 1~~
- [#3](url) — Available 2
- [#4](url) — Has **Done** in text
- ~~[#5](url) — Done 2~~
- [#6](url) — Available 3
`;
    const result = countIssueListItems(content);
    expect(result.availableCount).toBe(3);
    expect(result.completedCount).toBe(3);
  });
});
