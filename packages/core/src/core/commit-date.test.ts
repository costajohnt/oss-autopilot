import { describe, it, expect } from 'vitest';
import { commitDateOf, isRebasedSinceReview } from './commit-date.js';

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

describe('commitDateOf after a change request (#2042)', () => {
  const own = {
    authorDate: '2026-02-01T00:00:00Z',
    committerDate: '2026-02-03T00:00:00Z',
    authorLogin: 'contributor',
    committerLogin: 'contributor',
    reviewedSha: 'reviewed',
    reviewedParentSha: 'base1',
  };

  it('keeps the author date when the rewrite moved the commit onto a new parent (rebase)', () => {
    expect(commitDateOf({ ...own, parentSha: 'base2' })).toBe(own.authorDate);
  });

  it('uses the committer date for an amend that kept the reviewed parent', () => {
    expect(commitDateOf({ ...own, parentSha: 'base1' })).toBe(own.committerDate);
  });

  it('does not treat a new commit on top of the reviewed one as a rebase', () => {
    expect(isRebasedSinceReview({ ...own, parentSha: 'reviewed' })).toBe(false);
  });

  it('uses the committer date when any parent is unknown', () => {
    expect(commitDateOf({ ...own, parentSha: undefined })).toBe(own.committerDate);
    expect(commitDateOf({ ...own, parentSha: 'base2', reviewedParentSha: null })).toBe(own.committerDate);
  });
});

describe('commitDateOf for an author email linked to no GitHub account (#2042)', () => {
  const dates = { authorDate: '2026-02-01T00:00:00Z', committerDate: '2026-02-03T00:00:00Z' };

  it('treats a matching git email as the author rewriting their own commit', () => {
    expect(commitDateOf({ ...dates, authorEmail: 'Me@Example.com', committerEmail: 'me@example.com' })).toBe(
      dates.committerDate,
    );
  });

  it('keeps the author date when the git emails differ', () => {
    expect(commitDateOf({ ...dates, authorEmail: 'me@example.com', committerEmail: 'noreply@github.com' })).toBe(
      dates.authorDate,
    );
  });

  it('matches on login, not email, when the author has a login', () => {
    const emails = { authorEmail: 'me@example.com', committerEmail: 'me@example.com' };
    expect(commitDateOf({ ...dates, ...emails, authorLogin: 'contributor', committerLogin: 'maintainer' })).toBe(
      dates.authorDate,
    );
  });
});
