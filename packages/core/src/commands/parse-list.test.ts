/**
 * Tests for parse-issue-list command (#82)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseIssueList, pruneIssueList, runParseList } from './parse-list.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import * as fs from 'node:fs';

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

  // Freshness-sweep vocabulary recognized as terminal (#1179). Curators
  // use these annotations on a later occurrence of an issue to override
  // an earlier "pursue" line; the dedupe pass then drops the URL from
  // `available[]`.
  it('moves Hold items to completed', () => {
    const content = `- [#1](https://github.com/owner/repo/issues/1) — Fix bug
  - **Hold** — Score 6/10. Author has 2 PRs in flight.`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].number).toBe(1);
  });

  it('moves Continue watch items to completed', () => {
    const content = `- [#2](https://github.com/owner/repo/issues/2) — Watchlist
  - **Continue watch** — Maintainer absent for 30d.`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
  });

  it('moves Downgrade items to completed', () => {
    const content = `- [#3](https://github.com/owner/repo/issues/3) — Lower priority now
  - **Downgrade** — 7 → 5/10 after re-vet.`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
  });
});

describe('parseIssueList — indented sub-bullets with URLs (nested-URL defect)', () => {
  it('does not count a URL-bearing sub-bullet under a struck parent as available', () => {
    const content = `### Repo
- ~~[owncast/owncast#4950](https://github.com/owncast/owncast/issues/4950) (11k★) — title~~
  - **Score 8/10 — ✅ MERGED (confirmed 2026-08-07).** **PR [#4956](https://github.com/owncast/owncast/pull/4956)** (branch ...)
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(0);
    expect(result.completedCount).toBe(1);
    expect(result.completed[0].number).toBe(4950);
  });

  it('does not count a bold-starting paragraph with a URL as a list item', () => {
    const content = `**Dropped this round:** [go-git#827](https://github.com/go-git/go-git/issues/827) — someone else diagnosed it.
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(0);
    expect(result.completedCount).toBe(0);
  });

  it('URL-bearing sub-bullet still contributes score to the parent', () => {
    const content = `- [#1](https://github.com/owner/repo/issues/1) — Fix bug
  - **Maybe** — Score 8/10. Competitor PR: [#99](https://github.com/owner/repo/pull/99)
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(1);
    expect(result.available[0].number).toBe(1);
    expect(result.available[0].score).toBe(8);
  });
});

describe('parseIssueList — decorated status keyword matching', () => {
  it('moves parent to completed on decorated "✅ MERGED — ..." sub-bullet', () => {
    const content = `- [#1](https://github.com/owner/repo/issues/1) — Fix bug
  - **✅ MERGED — re-vet 2026-08-07: PR #5042 merged 2026-07-20, issue closed.**
`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
  });

  it('moves parent out of available on "✅ PR OPEN ..." sub-bullet (in-progress)', () => {
    const content = `- [#765](https://github.com/vadimdemedes/ink/issues/765) — Feature
  - **✅ PR OPEN 2026-08-09: #988**
`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
  });

  it('moves parent out of available on IMPLEMENTED sub-bullet (in-progress)', () => {
    const content = `- [#2](https://github.com/owner/repo/issues/2) — Feature
  - **IMPLEMENTED — awaiting review**
`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
  });

  it('does not match keyword prefixes of longer words (Holding is not Hold)', () => {
    const content = `- [#3](https://github.com/owner/repo/issues/3) — Feature
  - **Holding pattern notes** — Score 8/10
`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(1);
  });
});

describe('pruneIssueList — decorated status keywords', () => {
  it('does NOT delete decorated "**Hold — ...**" items', () => {
    const content = `### Repo
- [#1](https://github.com/owner/repo/issues/1) — Held back
  - **Hold — author has 2 PRs in flight.** Score 8/10
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(0);
    expect(pruned).toContain('issues/1');
  });

  it('deletes decorated "**Done — ...**" items', () => {
    const content = `### Repo
- [#5](https://github.com/owner/repo/issues/5) — Shipped item
  - **✅ Done — merged 2026-08-01.** Score 8/10
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(1);
    expect(pruned).not.toContain('issues/5');
  });
});

describe('parseIssueList — URL deduplication (#1179)', () => {
  it('dedupes the same URL appearing in two sections to one available entry', () => {
    const content = `## Pursue
- [#123](https://github.com/example/repo/issues/123) — Some bug
  - **Score 7/10** — Vetted Apr 1.

## Pending Vet
- [#123](https://github.com/example/repo/issues/123) — Re-checked, still relevant.
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(1);
    expect(result.completedCount).toBe(0);
    // First occurrence wins — preserves the original tier ("Pursue").
    expect(result.available[0].tier).toBe('Pursue');
  });

  it('terminal classification on second occurrence wins over available on first', () => {
    const content = `## Pursue
- [#123](https://github.com/example/repo/issues/123) — Some bug
  - **Score 7/10** — Vetted Apr 1.

## Pending Vet
### Freshness sweep
- [#123](https://github.com/example/repo/issues/123) — re-vetted
  - **Hold** (7 → 6/10). Author has 2 PRs in this repo already waiting.
`;
    const result = parseIssueList(content);
    expect(result.availableCount).toBe(0);
    expect(result.completedCount).toBe(1);
    expect(result.completed[0].url).toBe('https://github.com/example/repo/issues/123');
  });

  it('dedupes the same URL appearing twice in completed[]', () => {
    const content = `## Done
- ~~[#1](https://github.com/owner/repo/issues/1)~~ Fixed in PR #2.

## Archive
- [#1](https://github.com/owner/repo/issues/1) — Done. Notes preserved.
`;
    const result = parseIssueList(content);
    expect(result.completedCount).toBe(1);
  });
});

describe('parseIssueList — first-bold anchoring (#1179)', () => {
  // The terminal vocabulary now includes common English verbs ("Hold",
  // "Downgrade"), which means a regex matching anywhere on the line would
  // mis-classify any sub-bullet whose explanatory tail happens to bold one
  // of those words. Anchoring to the first bold span on the line keeps the
  // curator's "first **bold** = the status tag" convention intact.
  it('does not move items based on bolded keywords in the explanatory tail', () => {
    const content = `- [#7](https://github.com/owner/repo/issues/7) — Trace bug
  - **Maybe** — yesterday's **Done** sweep recommended a retry.`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(1);
    expect(result.completed).toHaveLength(0);
  });

  it('does not move items when "hold" appears as bold prose, not as the status tag', () => {
    const content = `- [#8](https://github.com/owner/repo/issues/8) — Resilience work
  - **Score 8/10** — author asked us to **hold** off until v3 lands.`;
    const result = parseIssueList(content);
    expect(result.available).toHaveLength(1);
    expect(result.available[0].score).toBe(8);
  });
});

describe('pruneIssueList — preserves parked entries (#1179)', () => {
  // pruneIssueList mutates the markdown file in place. The new
  // freshness-sweep vocabulary (`**Hold**`, `**Continue watch**`,
  // `**Downgrade**`) parks issues — the curator's intent is "don't pursue
  // right now", not "delete from disk". The narrower
  // `isSubBulletDeletable` predicate keeps these on disk while
  // parseIssueList's broader `isSubBulletTerminal` still excludes them
  // from the in-memory `available[]` count.
  it('preserves Hold items (parked, not deleted)', () => {
    const content = `### Repo
- [#1](https://github.com/owner/repo/issues/1) — Held back
  - **Hold** — Score 8/10. Author has 2 PRs in flight.
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(0);
    expect(pruned).toContain('https://github.com/owner/repo/issues/1');
  });

  it('preserves Continue watch items', () => {
    const content = `### Repo
- [#2](https://github.com/owner/repo/issues/2) — Watchlist
  - **Continue watch** — Score 7/10. Maintainer absent for 30d.
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(0);
    expect(pruned).toContain('https://github.com/owner/repo/issues/2');
  });

  it('preserves Downgrade items', () => {
    const content = `### Repo
- [#3](https://github.com/owner/repo/issues/3) — Lower priority now
  - **Downgrade** — Score 6/10. 7 → 6 after re-vet.
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(0);
    expect(pruned).toContain('https://github.com/owner/repo/issues/3');
  });

  it('still deletes Skip / Done / Dropped / Merged / Closed items', () => {
    const content = `### Repo
- [#4](https://github.com/owner/repo/issues/4) — Skipped
  - **Skip** — Score 3/10. Existing PR.
- [#5](https://github.com/owner/repo/issues/5) — Done
  - **Done** — Merged.
`;
    const { pruned, removedCount } = pruneIssueList(content);
    expect(removedCount).toBe(2);
    expect(pruned).not.toContain('issues/4');
    expect(pruned).not.toContain('issues/5');
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
