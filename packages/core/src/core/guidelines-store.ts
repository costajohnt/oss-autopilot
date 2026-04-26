/**
 * Per-repo guidelines persistence on top of the Gist freeform-document API
 * (#867 PR 2).
 *
 * Each repo gets one markdown file named `guidelines--{owner}--{repo}.md`
 * stored in the user's oss-autopilot Gist alongside `state.json`. The file
 * holds extracted guidance from past PR review feedback. Reads and writes go
 * through the in-memory cache that `GistStateStore` already maintains; the
 * file persists on the next `push()`.
 *
 * The byte cap (8 KB) is enforced at write time to keep claim-time context
 * injection small. Larger guidance should be split across categories or
 * deferred to a follow-up consolidation pass.
 */
import type { GistStateStore } from './gist-state-store.js';
import { OssAutopilotError } from './errors.js';

/** Filename prefix shared by every guidelines file in the Gist. */
export const GUIDELINES_FILE_PREFIX = 'guidelines--';

/** Hard byte budget for a single guidelines file (#867 design log §1). */
export const GUIDELINES_MAX_BYTES = 8_192;

/** Suffix appended to the filename so it renders as markdown in Gist. */
const GUIDELINES_FILE_SUFFIX = '.md';

/**
 * Convert an `owner/repo` pair into the filename used inside the Gist.
 * Slashes are escaped as `--` so the filename is filesystem-safe and
 * unambiguous when parsing back to a repo string.
 */
export function guidelinesFilename(repo: string): string {
  if (!repo.includes('/')) {
    throw new OssAutopilotError(`Invalid repo identifier "${repo}". Expected "owner/repo" format.`, 'INVALID_REPO_ID');
  }
  // GitHub forbids `/` in owner and repo, so the only `/` is the separator.
  const [owner, name] = repo.split('/');
  return `${GUIDELINES_FILE_PREFIX}${owner}--${name}${GUIDELINES_FILE_SUFFIX}`;
}

/**
 * Inverse of {@link guidelinesFilename}. Returns null when the filename
 * doesn't match the guidelines convention.
 */
export function repoFromGuidelinesFilename(filename: string): string | null {
  if (!filename.startsWith(GUIDELINES_FILE_PREFIX)) return null;
  if (!filename.endsWith(GUIDELINES_FILE_SUFFIX)) return null;
  const middle = filename.slice(GUIDELINES_FILE_PREFIX.length, filename.length - GUIDELINES_FILE_SUFFIX.length);
  // Only split on the FIRST `--` separator. Repo names with `--` are rare
  // but legal; owner names cannot contain `--` per GitHub username rules.
  const sep = middle.indexOf('--');
  if (sep === -1) return null;
  const owner = middle.slice(0, sep);
  const name = middle.slice(sep + 2);
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

/**
 * Thrown by {@link setGuidelines} / {@link deleteGuidelines} when the
 * StateManager is not in Gist mode. Catch + degrade gracefully when surfacing
 * to user-facing flows: per-repo guidelines simply aren't available without a
 * Gist to store them in.
 */
export class GuidelinesNotAvailableError extends OssAutopilotError {
  constructor(message?: string) {
    super(
      message ??
        'Per-repo guidelines require Gist persistence. Run `oss-autopilot setup` to enable Gist sync, then retry.',
      'GUIDELINES_NOT_AVAILABLE',
    );
    this.name = 'GuidelinesNotAvailableError';
  }
}

/**
 * Thrown by {@link setGuidelines} when content exceeds {@link GUIDELINES_MAX_BYTES}.
 * Surfaced separately from generic validation errors so consumers can prompt the
 * user with a "trim or split" UX rather than a generic shape rejection.
 */
export class GuidelinesTooLargeError extends OssAutopilotError {
  constructor(byteSize: number, max: number = GUIDELINES_MAX_BYTES) {
    super(
      `Guidelines content is ${byteSize} bytes, exceeding the ${max}-byte cap. ` + `Trim or split across categories.`,
      'GUIDELINES_TOO_LARGE',
    );
    this.name = 'GuidelinesTooLargeError';
  }
}

/**
 * Read the guidelines file for a repo from the Gist cache. Returns null when
 * the store is not in Gist mode, the file does not exist, or the file is
 * present but empty (treated as a tombstone left by {@link deleteGuidelines}).
 */
export function getGuidelines(store: GistStateStore | null, repo: string): string | null {
  if (!store) return null;
  const content = store.getDocument(guidelinesFilename(repo));
  if (content === null || content === '') return null;
  return content;
}

/**
 * Write or replace the guidelines file for a repo. Throws if the store is not
 * in Gist mode or the content exceeds the byte budget.
 */
export function setGuidelines(store: GistStateStore | null, repo: string, content: string): void {
  if (!store) throw new GuidelinesNotAvailableError();
  const byteSize = Buffer.byteLength(content, 'utf-8');
  if (byteSize > GUIDELINES_MAX_BYTES) {
    throw new GuidelinesTooLargeError(byteSize);
  }
  store.setDocument(guidelinesFilename(repo), content);
}

/**
 * Delete the guidelines file for a repo. No-op if the file doesn't exist.
 * Implementation: write an empty string. The Gist API treats files with
 * empty content as deletions on the next push, matching the existing
 * single-source-of-truth model.
 */
export function deleteGuidelines(store: GistStateStore | null, repo: string): void {
  if (!store) throw new GuidelinesNotAvailableError();
  // setDocument('') is interpreted as deletion; the GistStateStore push path
  // already strips empty-content files before sending to the Gist API.
  store.setDocument(guidelinesFilename(repo), '');
}

/**
 * List every repo (as `owner/repo`) that has a non-empty guidelines file in
 * the cache. Tombstoned (empty-content) files are excluded so the result
 * matches what {@link getGuidelines} would actually return.
 *
 * Returns an empty array when the store is null or no files exist.
 */
export function listGuidelinesRepos(store: GistStateStore | null): string[] {
  if (!store) return [];
  const filenames = store.listDocuments(GUIDELINES_FILE_PREFIX);
  const repos: string[] = [];
  for (const filename of filenames) {
    const repo = repoFromGuidelinesFilename(filename);
    // Skip files we can't decode (e.g. older formats, hand-edited) — better
    // than throwing and breaking listGuidelinesRepos for everyone.
    if (!repo) continue;
    // Skip tombstones — empty content means the user deleted these guidelines.
    const content = store.getDocument(filename);
    if (content === null || content === '') continue;
    repos.push(repo);
  }
  return repos.sort();
}
