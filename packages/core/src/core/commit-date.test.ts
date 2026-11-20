import { describe, it, expect } from 'vitest';
import { commitDateOf } from './commit-date.js';

describe('commitDateOf (#1919)', () => {
  const dates = { authorDate: '2026-02-01T00:00:00Z', committerDate: '2026-02-03T00:00:00Z' };

  it("uses the committer date for the author's own amend or rebase", () => {
    expect(commitDateOf({ ...dates, authorLogin: 'Contributor', committerLogin: 'contributor' })).toBe(
      dates.committerDate,
    );
  });

  it('keeps the author date when someone else rewrote the commit', () => {
    expect(commitDateOf({ ...dates, authorLogin: 'contributor', committerLogin: 'maintainer' })).toBe(dates.authorDate);
    expect(commitDateOf({ ...dates, authorLogin: 'contributor', committerLogin: 'web-flow' })).toBe(dates.authorDate);
    expect(commitDateOf(dates)).toBe(dates.authorDate);
  });

  it('falls back to whichever date is present', () => {
    expect(commitDateOf({ committerDate: dates.committerDate, authorLogin: 'contributor' })).toBe(dates.committerDate);
    expect(commitDateOf({ authorDate: null, committerDate: null })).toBeUndefined();
  });
});
