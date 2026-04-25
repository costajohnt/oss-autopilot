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
const OWNER_PATTERN = /^[a-zA-Z0-9_-]+$/;
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+$/;

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
  const [owner, repo] = repoFullName.split('/');
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
