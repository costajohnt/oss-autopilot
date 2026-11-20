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
}

/**
 * The committer date when the author also committed it (their own amend or
 * rebase moved it while Git kept the old author date), the author date when
 * someone else rewrote it (a maintainer's rebase does not make the author's
 * old work new, and is not the author addressing feedback). Either falls back
 * to the other when missing.
 */
export function commitDateOf(c: CommitDates): string | undefined {
  const login = c.authorLogin?.toLowerCase();
  const isOwnRewrite = login !== undefined && c.committerLogin?.toLowerCase() === login;
  const date = isOwnRewrite ? (c.committerDate ?? c.authorDate) : (c.authorDate ?? c.committerDate);
  return date ?? undefined;
}
