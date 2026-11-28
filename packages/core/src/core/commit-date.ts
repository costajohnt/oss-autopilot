/**
 * The date a commit reached a PR under. Leaf module: no imports, shared by the
 * PR status pipeline (#1919) and the reviewed-PR scan.
 */

/** Dates and GitHub logins of a commit's author and committer, as either transport returns them. */
export interface CommitDates {
  authorDate?: string | null;
  committerDate?: string | null;
  authorLogin?: string | null;
  committerLogin?: string | null;
  /** Author and committer emails from the Git commit: who wrote it when the author email is linked to no GitHub account. */
  authorEmail?: string | null;
  committerEmail?: string | null;
  /** First parent of this commit. */
  parentSha?: string | null;
  /** The commit the latest change request was made against, and its first parent (#2042). */
  reviewedSha?: string | null;
  reviewedParentSha?: string | null;
}

/**
 * Whether the author also committed it: their own amend or rebase. Matched on
 * GitHub login, or on the Git email when the author email is linked to no
 * GitHub account (no author login), so an unlinked author's amend still counts.
 */
export function isOwnRewrite(c: CommitDates): boolean {
  const login = c.authorLogin?.toLowerCase();
  if (login) return c.committerLogin?.toLowerCase() === login;
  const email = c.authorEmail?.toLowerCase();
  return !!email && c.committerEmail?.toLowerCase() === email;
}

/**
 * Whether the commit sits on a different parent than the reviewed commit did
 * (and is not a new commit on top of it): the branch was rebased since the
 * review (#2042). False when any of the three SHAs is unknown.
 */
export function isRebasedSinceReview(c: CommitDates): boolean {
  const { parentSha, reviewedSha, reviewedParentSha } = c;
  if (!parentSha || !reviewedSha || !reviewedParentSha) return false;
  return parentSha !== reviewedParentSha && parentSha !== reviewedSha;
}

/**
 * The committer date when the author also committed it (their own amend moved
 * it while Git kept the old author date), the author date when someone else
 * rewrote it (a maintainer's rebase does not make the author's old work new,
 * and is not the author addressing feedback). Either falls back to the other
 * when missing.
 *
 * The author's own rewrite also keeps the author date when it moved the
 * commit onto a new parent since the latest change request: a rebase onto
 * the base branch moves the committer date without touching the review's
 * points, so it must not read as addressing them (#2042). An amend in place
 * keeps the reviewed commit's parent and still counts.
 */
export function commitDateOf(c: CommitDates): string | undefined {
  const isAddressingRewrite = isOwnRewrite(c) && !isRebasedSinceReview(c);
  const date = isAddressingRewrite ? (c.committerDate ?? c.authorDate) : (c.authorDate ?? c.committerDate);
  return date ?? undefined;
}
