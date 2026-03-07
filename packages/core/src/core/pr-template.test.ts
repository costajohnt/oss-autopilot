import { describe, it, expect, vi } from 'vitest';
import { fetchPRTemplate } from './pr-template.js';

function makeOctokit(responses: Record<string, { status: number; data?: unknown; message?: string }>) {
  return {
    repos: {
      getContent: vi.fn().mockImplementation(({ owner, repo, path }: { owner: string; repo: string; path: string }) => {
        const key = `${owner}/${repo}/${path}`;
        const response = responses[key];
        if (!response || response.status === 404) {
          const err = new Error('Not Found') as Error & { status: number };
          err.status = 404;
          throw err;
        }
        if (response.status !== 200) {
          const err = new Error(response.message ?? 'Server Error') as Error & {
            status: number;
            response?: { headers: Record<string, string> };
          };
          err.status = response.status;
          // Simulate rate limit response headers for 403 rate limit errors
          if (response.message?.includes('rate limit')) {
            err.response = { headers: { 'x-ratelimit-remaining': '0' } };
          }
          throw err;
        }
        return { data: response.data };
      }),
    },
  } as any;
}

function base64(content: string): string {
  return Buffer.from(content).toString('base64');
}

describe('fetchPRTemplate', () => {
  it('should find template at .github/PULL_REQUEST_TEMPLATE.md', async () => {
    const template = '## Summary\n\n## Test Plan\n';
    const octokit = makeOctokit({
      'owner/repo/.github/PULL_REQUEST_TEMPLATE.md': {
        status: 200,
        data: { type: 'file', content: base64(template), encoding: 'base64' },
      },
    });

    const result = await fetchPRTemplate(octokit, 'owner', 'repo');

    expect(result.template).toBe(template);
    expect(result.source).toBe('.github/PULL_REQUEST_TEMPLATE.md');
  });

  it('should try paths in priority order and return first match', async () => {
    const template = '## Description\n';
    const octokit = makeOctokit({
      // First path doesn't exist
      // Second path exists
      'owner/repo/.github/pull_request_template.md': {
        status: 200,
        data: { type: 'file', content: base64(template), encoding: 'base64' },
      },
    });

    const result = await fetchPRTemplate(octokit, 'owner', 'repo');

    expect(result.template).toBe(template);
    expect(result.source).toBe('.github/pull_request_template.md');
    // Should have tried .github/PULL_REQUEST_TEMPLATE.md first (404), then found the second
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
  });

  it('should find template at docs/pull_request_template.md', async () => {
    const template = '## Changes\n';
    const octokit = makeOctokit({
      'owner/repo/docs/pull_request_template.md': {
        status: 200,
        data: { type: 'file', content: base64(template), encoding: 'base64' },
      },
    });

    const result = await fetchPRTemplate(octokit, 'owner', 'repo');

    expect(result.template).toBe(template);
    expect(result.source).toBe('docs/pull_request_template.md');
  });

  it('should find template at root pull_request_template.md', async () => {
    const template = '## What\n## Why\n';
    const octokit = makeOctokit({
      'owner/repo/pull_request_template.md': {
        status: 200,
        data: { type: 'file', content: base64(template), encoding: 'base64' },
      },
    });

    const result = await fetchPRTemplate(octokit, 'owner', 'repo');

    expect(result.template).toBe(template);
    expect(result.source).toBe('pull_request_template.md');
  });

  it('should return null when no template exists', async () => {
    const octokit = makeOctokit({});

    const result = await fetchPRTemplate(octokit, 'owner', 'repo');

    expect(result.template).toBeNull();
    expect(result.source).toBeNull();
    // Should have tried all 4 paths
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(4);
  });

  it('should skip directories returned by getContent', async () => {
    const octokit = makeOctokit({
      'owner/repo/.github/PULL_REQUEST_TEMPLATE.md': {
        status: 200,
        data: [{ type: 'file', name: 'bug.md' }], // directory listing
      },
    });

    const result = await fetchPRTemplate(octokit, 'owner', 'repo');

    expect(result.template).toBeNull();
  });

  it('should stop on 500 errors and return null', async () => {
    const octokit = makeOctokit({
      'owner/repo/.github/PULL_REQUEST_TEMPLATE.md': { status: 500 },
    });

    const result = await fetchPRTemplate(octokit, 'owner', 'repo');

    expect(result.template).toBeNull();
    // Should stop after the 500 error, not try remaining paths
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it('should propagate 429 rate limit errors', async () => {
    const octokit = makeOctokit({
      'owner/repo/.github/PULL_REQUEST_TEMPLATE.md': { status: 429, message: 'rate limit exceeded' },
    });

    await expect(fetchPRTemplate(octokit, 'owner', 'repo')).rejects.toThrow('rate limit exceeded');
  });

  it('should propagate 401 auth errors', async () => {
    const octokit = makeOctokit({
      'owner/repo/.github/PULL_REQUEST_TEMPLATE.md': { status: 401, message: 'Bad credentials' },
    });

    await expect(fetchPRTemplate(octokit, 'owner', 'repo')).rejects.toThrow('Bad credentials');
  });
});
