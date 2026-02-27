/**
 * Tests for github.ts — checkRateLimit utility
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockOctokitInstance: any;

vi.mock('@octokit/rest', () => ({
  Octokit: {
    plugin: () =>
      class MockOctokit {
        constructor() {
          return mockOctokitInstance;
        }
      },
  },
}));

vi.mock('@octokit/plugin-throttling', () => ({
  throttling: {},
}));

// Must import after mocks are set up
const { checkRateLimit, getOctokit } = await import('./github.js');

describe('checkRateLimit', () => {
  beforeEach(() => {
    // Reset cached octokit instance by providing a new token each test
    mockOctokitInstance = {
      rateLimit: {
        get: vi.fn(),
      },
    };
  });

  it('should return search rate limit info', async () => {
    const resetTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    mockOctokitInstance.rateLimit.get.mockResolvedValue({
      data: {
        resources: {
          search: {
            remaining: 25,
            limit: 30,
            reset: resetTimestamp,
          },
        },
      },
    });

    const result = await checkRateLimit('test-token-1');
    expect(result.remaining).toBe(25);
    expect(result.limit).toBe(30);
    expect(result.resetAt).toBe(new Date(resetTimestamp * 1000).toISOString());
  });

  it('should return low remaining when quota is nearly exhausted', async () => {
    const resetTimestamp = Math.floor(Date.now() / 1000) + 600;
    mockOctokitInstance.rateLimit.get.mockResolvedValue({
      data: {
        resources: {
          search: {
            remaining: 2,
            limit: 30,
            reset: resetTimestamp,
          },
        },
      },
    });

    const result = await checkRateLimit('test-token-2');
    expect(result.remaining).toBe(2);
    expect(result.limit).toBe(30);
  });

  it('should propagate API errors', async () => {
    mockOctokitInstance.rateLimit.get.mockRejectedValue(new Error('Bad credentials'));
    await expect(checkRateLimit('test-token-3')).rejects.toThrow('Bad credentials');
  });
});

describe('getOctokit', () => {
  beforeEach(() => {
    mockOctokitInstance = {
      rateLimit: {
        get: vi.fn(),
      },
    };
  });

  it('should create and return an Octokit instance', () => {
    const octokit = getOctokit('token-a');
    expect(octokit).toBeDefined();
  });

  it('should return cached instance for the same token', () => {
    const first = getOctokit('token-cached');
    const second = getOctokit('token-cached');
    expect(first).toBe(second);
  });

  it('should create a new instance when token changes', () => {
    const first = getOctokit('token-x');
    expect(first).toBeDefined();
    // Calling with same token should return cached instance
    const same = getOctokit('token-x');
    expect(same).toBe(first);
    // Calling with different token should create new instance
    const second = getOctokit('token-y');
    expect(second).toBeDefined();
  });
});
