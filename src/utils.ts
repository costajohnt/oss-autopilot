/**
 * Shared utility functions
 */

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  number: number;
  type: 'pull' | 'issues';
}

/**
 * Parse a GitHub PR or issue URL
 */
export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  const prMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (prMatch) {
    return {
      owner: prMatch[1],
      repo: prMatch[2],
      number: parseInt(prMatch[3], 10),
      type: 'pull',
    };
  }

  const issueMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (issueMatch) {
    return {
      owner: issueMatch[1],
      repo: issueMatch[2],
      number: parseInt(issueMatch[3], 10),
      type: 'issues',
    };
  }

  return null;
}

/**
 * Calculate days between two dates
 */
export function daysBetween(from: Date, to: Date = new Date()): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Split repo string "owner/repo" into components
 */
export function splitRepo(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repoFullName.split('/');
  return { owner, repo };
}
