/**
 * GitHub URL parsing + owner/repo helpers.
 *
 * All functions enforce an `https://github.com/` prefix and validate
 * owner/repo characters. Extracted from utils.ts under #1116.
 */

/**
 * Represents a parsed GitHub pull request or issue URL.
 *
 * @property owner - The repository owner (e.g., `"facebook"`)
 * @property repo - The repository name (e.g., `"react"`)
 * @property number - The PR or issue number
 * @property type - Whether the URL points to a pull request or an issue
 */
export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  number: number;
  type: 'pull' | 'issues';
}

// Validation patterns for GitHub owner and repo names
const OWNER_PATTERN = /^[\w-]+$/;
const REPO_PATTERN = /^[\w.-]+$/;

function isValidOwnerRepo(owner: string, repo: string): boolean {
  return OWNER_PATTERN.test(owner) && REPO_PATTERN.test(repo);
}

/**
 * Parses a GitHub pull request or issue URL into its components.
 *
 * Only accepts HTTPS GitHub URLs (`https://github.com/...`). Returns `null` for
 * invalid URLs, non-GitHub URLs, or URLs with invalid owner/repo characters.
 *
 * @example
 * parseGitHubUrl('https://github.com/facebook/react/pull/123')
 * // { owner: "facebook", repo: "react", number: 123, type: "pull" }
 *
 * @example
 * parseGitHubUrl('https://example.com/not-github')
 * // null
 */
export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  if (!url.startsWith('https://github.com/')) {
    return null;
  }

  const prMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (prMatch) {
    const owner = prMatch[1];
    const repo = prMatch[2];
    if (!isValidOwnerRepo(owner, repo)) {
      return null;
    }
    return {
      owner,
      repo,
      number: parseInt(prMatch[3], 10),
      type: 'pull',
    };
  }

  const issueMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (issueMatch) {
    const owner = issueMatch[1];
    const repo = issueMatch[2];
    if (!isValidOwnerRepo(owner, repo)) {
      return null;
    }
    return {
      owner,
      repo,
      number: parseInt(issueMatch[3], 10),
      type: 'issues',
    };
  }

  return null;
}

/**
 * Case-insensitive identity of a GitHub issue or PR URL: `owner/repo#number`,
 * lowercased. Trailing slashes, `#fragment`s and `?query`s fall away because
 * only the path segments are read, and `/issues/N` and `/pull/N` map to the
 * same key: a repo has one number space, so a bare `#N` mention names the
 * same object whichever kind it is. Returns null when the URL does not
 * parse (see {@link parseGitHubUrl}).
 *
 * @example
 * issueRefKey('https://github.com/Org/Repo/issues/5/')
 * // "org/repo#5"
 */
export function issueRefKey(url: string): string | null {
  const parsed = parseGitHubUrl(url);
  return parsed ? `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}#${parsed.number}` : null;
}

/**
 * The key of a URL-keyed state map (`dismissedIssues`, `dismissedPRHeads`,
 * `statusOverrides`) that names the same issue or PR as `url` (#2001): `url`
 * itself when present, else the key with the same {@link issueRefKey}, so a
 * mixed-case owner/repo or the `/issues/N` form of a PR still finds the entry.
 * Keys stay URLs because older clients sharing the Gist look them up by exact
 * URL. undefined when there is no such key.
 */
export function findRefKey(map: Readonly<Record<string, unknown>> | undefined, url: string): string | undefined {
  if (!map) return undefined;
  if (Object.hasOwn(map, url)) return url;
  const key = issueRefKey(url);
  // ponytail: linear scan per miss, and these maps are never pruned, so cost grows with every
  // dismiss/override ever made. Upgrade: build a ref -> key index once per daily/dashboard pass.
  return key === null ? undefined : Object.keys(map).find((k) => issueRefKey(k) === key);
}

/**
 * Extracts the owner and repo from a GitHub web URL
 * (e.g. `https://github.com/owner/repo/pull/42`, `https://github.com/owner/repo/`).
 *
 * Unlike {@link parseGitHubUrl}, this does **not** require a PR or issue number.
 *
 * @example
 * extractOwnerRepo('https://github.com/vercel/next.js/')
 * // { owner: "vercel", repo: "next.js" }
 */
export function extractOwnerRepo(url: string): { owner: string; repo: string } | null {
  if (!url.startsWith('https://github.com/')) return null;
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;

  const owner = match[1];
  const repo = match[2];
  if (!isValidOwnerRepo(owner, repo)) return null;

  return { owner, repo };
}

/**
 * Splits an `"owner/repo"` string into its owner and repo components.
 *
 * @throws {Error} If the input is not in the form `"owner/repo"`.
 */
export function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split('/', 2);
  if (!owner || !repo) {
    throw new Error(`Invalid repo format: expected "owner/repo", got "${repoFullName}"`);
  }
  return { owner, repo };
}

/**
 * Case-insensitive check whether a repo owner matches the given GitHub username.
 * Used to skip a user's own repos (PRs to your own repos aren't OSS contributions).
 */
export function isOwnRepo(owner: string, username: string): boolean {
  return owner.toLowerCase() === username.toLowerCase();
}

/** True when `owner` is listed in `config.untrackedOrgs` (case-insensitive). */
export function isUntrackedOrg(owner: string, untrackedOrgs: readonly string[] = []): boolean {
  const ownerLower = owner.toLowerCase();
  return untrackedOrgs.some((org) => org.toLowerCase() === ownerLower);
}

/** HTML comments and code: where PR templates keep example `Fixes #123` lines. */
const NON_PROSE_RE = /<!--[\s\S]*?-->|```[\s\S]*?```|(`+)[^`]*\1/g;

/** GitHub's PR body limit; also bounds NON_PROSE_RE's scan on an unclosed `<!--`. */
export const MAX_BODY_CHARS = 65_536;

/** Markdown with its HTML comments and code (fenced and inline) blanked out: the text GitHub links refs in. */
export function stripNonProse(markdown: string): string {
  return markdown.replaceAll(NON_PROSE_RE, ' ');
}

/**
 * GitHub's closing keyword (close, closes, closed, fix, fixes, fixed, resolve,
 * resolves, resolved; any case), an optional colon, then one ref: `#12`,
 * `owner/repo#12` or an issue URL. Each ref needs its own keyword, as on
 * GitHub, so `Fixes #1, #2` closes only #1.
 */
const CLOSING_REF_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)(?:https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|([\w.-]+\/[\w.-]+)?#(\d+))\b/gi;

/** One closing reference: `repo` is the `owner/repo` the text names, null for a bare `#N`. */
export interface ClosingRef {
  repo: string | null;
  number: number;
}

/**
 * Issues `text` closes with a GitHub closing keyword (#2048), in order of
 * appearance. With `markdown` (a PR body), HTML comments and code are
 * skipped and only the first {@link MAX_BODY_CHARS} characters are read, as
 * GitHub links nothing there; without it (a commit message) every line counts.
 */
export function findClosingRefs(text: string, options: { markdown?: boolean } = {}): ClosingRef[] {
  const scanned = options.markdown ? stripNonProse(text.slice(0, MAX_BODY_CHARS)) : text;
  return [...scanned.matchAll(CLOSING_REF_RE)].map((m) => ({
    repo: m[1] ?? m[3] ?? null,
    number: Number(m[2] ?? m[4]),
  }));
}
