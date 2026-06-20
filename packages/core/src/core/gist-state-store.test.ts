/**
 * Tests for GistStateStore — bootstrap flow, in-memory cache, and local cache write-through.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GistStateStore, GIST_DESCRIPTION, STATE_FILE_NAME, type OctokitLike } from './gist-state-store.js';
import { AgentStateSchema } from './state-schema.js';
import { GistCorruptError } from './errors.js';
import { createFreshState } from './state-persistence.js';

// ── Mock utils.js to redirect path helpers to temp directories ────────────────

let mockTmpDir = '';

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  return {
    ...actual,
    getDataDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) {
        fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      }
      return mockTmpDir;
    },
    getGistIdPath: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) {
        fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      }
      return path.join(mockTmpDir, 'gist-id');
    },
    getStateCachePath: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) {
        fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      }
      return path.join(mockTmpDir, 'state-cache.json');
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid v4 state object as JSON string. */
function makeStateJson(overrides: Record<string, unknown> = {}): string {
  const state = {
    version: 4,
    activeIssues: [],
    repoScores: {},
    config: {
      setupComplete: false,
      githubUsername: 'testuser',
      maxActivePRs: 10,
      dormantThresholdDays: 30,
      approachingDormantDays: 25,
      maxIssueAgeDays: 90,
      languages: ['typescript'],
      labels: ['good first issue'],
      excludeRepos: [],
      trustedProjects: [],
      minRepoScoreThreshold: 4,
      starredRepos: [],
      squashByDefault: true,
      minStars: 50,
      includeDocIssues: true,
      aiPolicyBlocklist: [],
      shelvedPRUrls: [],
      dismissedIssues: {},
      projectCategories: [],
      preferredOrgs: [],
    },
    lastRunAt: new Date().toISOString(),
    ...overrides,
  };
  return JSON.stringify(state, null, 2);
}

/** Build a mock Gist API response. */
function makeGistResponse(gistId: string, stateJson?: string) {
  const files: Record<string, { filename: string; content: string }> = {};
  if (stateJson !== undefined) {
    files[STATE_FILE_NAME] = { filename: STATE_FILE_NAME, content: stateJson };
  }
  return {
    data: {
      id: gistId,
      description: GIST_DESCRIPTION,
      files,
    },
  };
}

/** Create a mock Octokit with gists methods as vi.fn(). */
type MockOctokit = OctokitLike & {
  gists: {
    get: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

function makeMockOctokit(): MockOctokit {
  // The cast is load-bearing: a bare vi.fn() satisfies the Mock side of the
  // intersection but not OctokitLike's concrete call signatures.
  return {
    gists: {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as MockOctokit;
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('GistStateStore', () => {
  let tmpDir: string;
  let octokit: ReturnType<typeof makeMockOctokit>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-store-test-'));
    mockTmpDir = tmpDir;
    octokit = makeMockOctokit();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  describe('bootstrap — path 1: local Gist ID exists', () => {
    it('should fetch the Gist by locally stored ID and return state', async () => {
      const gistId = 'abc123local';
      const stateJson = makeStateJson();

      // Pre-seed the local gist-id file
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);

      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.gistId).toBe(gistId);
      expect(result.created).toBe(false);
      expect(result.state.version).toBe(4);
      expect(octokit.gists.get).toHaveBeenCalledWith({ gist_id: gistId });
      // list is called once for the preflight scope check, but not for search
      expect(octokit.gists.list).toHaveBeenCalledTimes(1);
      expect(octokit.gists.list).toHaveBeenCalledWith({ per_page: 1, page: 1 });
      expect(octokit.gists.create).not.toHaveBeenCalled();
    });

    it('should populate the in-memory file cache with all Gist files', async () => {
      const gistId = 'abc123cache';
      const stateJson = makeStateJson();

      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);

      const response = makeGistResponse(gistId, stateJson);
      response.data.files['guidelines.md'] = {
        filename: 'guidelines.md',
        content: '# Guidelines\nBe nice.',
      };
      octokit.gists.get.mockResolvedValue(response);

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      expect(store.cachedFiles.size).toBe(2);
      expect(store.cachedFiles.get(STATE_FILE_NAME)).toBe(stateJson);
      expect(store.cachedFiles.get('guidelines.md')).toBe('# Guidelines\nBe nice.');
    });

    it('should write local state cache file after successful fetch', async () => {
      const gistId = 'abc123writecache';
      const stateJson = makeStateJson();

      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const cachePath = path.join(tmpDir, 'state-cache.json');
      expect(fs.existsSync(cachePath)).toBe(true);

      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      expect(cached.version).toBe(4);
    });

    it('should fall through to search if local Gist ID fetch fails', async () => {
      const localId = 'stale-id';
      const searchId = 'found-via-search';
      const stateJson = makeStateJson();

      fs.writeFileSync(path.join(tmpDir, 'gist-id'), localId);

      // GET for stale ID fails
      octokit.gists.get.mockRejectedValueOnce(new Error('Not Found'));
      // Search finds a different Gist
      octokit.gists.list.mockResolvedValue({
        data: [{ id: searchId, description: GIST_DESCRIPTION }],
      });
      // GET for found ID succeeds
      octokit.gists.get.mockResolvedValueOnce(makeGistResponse(searchId, stateJson));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.gistId).toBe(searchId);
      expect(result.created).toBe(false);

      // Local gist-id file should be updated
      const storedId = fs.readFileSync(path.join(tmpDir, 'gist-id'), 'utf8');
      expect(storedId).toBe(searchId);
    });
  });

  describe('bootstrap — path 2: search finds Gist', () => {
    it('should find Gist by description and store ID locally', async () => {
      const gistId = 'search-found-id';
      const stateJson = makeStateJson();

      // No local gist-id file
      octokit.gists.list.mockResolvedValue({
        data: [
          { id: 'other-gist', description: 'unrelated' },
          { id: gistId, description: GIST_DESCRIPTION },
        ],
      });
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.gistId).toBe(gistId);
      expect(result.created).toBe(false);
      expect(result.state.version).toBe(4);

      // Should have written the local gist-id file
      const storedId = fs.readFileSync(path.join(tmpDir, 'gist-id'), 'utf8');
      expect(storedId).toBe(gistId);

      // Should have written local state cache
      expect(fs.existsSync(path.join(tmpDir, 'state-cache.json'))).toBe(true);
    });

    it('should page through multiple list pages to find the Gist', async () => {
      const gistId = 'page-2-gist';
      const stateJson = makeStateJson();

      // Preflight scope check
      octokit.gists.list.mockResolvedValueOnce({ data: [] });

      // Page 1: 100 unrelated Gists (not empty, so search continues)
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: `unrelated-${i}`,
        description: `other gist ${i}`,
      }));
      octokit.gists.list.mockResolvedValueOnce({ data: page1 });

      // Page 2: contains target
      octokit.gists.list.mockResolvedValueOnce({
        data: [{ id: gistId, description: GIST_DESCRIPTION }],
      });

      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.gistId).toBe(gistId);
      // 1 preflight + 2 search pages
      expect(octokit.gists.list).toHaveBeenCalledTimes(3);
    });
  });

  describe('bootstrap — path 3: create new Gist', () => {
    it('should create a new Gist when none exists', async () => {
      const newGistId = 'newly-created';

      // No local gist-id file
      // Search returns empty on first page
      octokit.gists.list.mockResolvedValue({ data: [] });

      const freshState = createFreshState();
      const freshJson = JSON.stringify(freshState, null, 2);

      octokit.gists.create.mockResolvedValue({
        data: {
          id: newGistId,
          description: GIST_DESCRIPTION,
          files: {
            [STATE_FILE_NAME]: { filename: STATE_FILE_NAME, content: freshJson },
          },
        },
      });

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.gistId).toBe(newGistId);
      expect(result.created).toBe(true);
      expect(result.state.version).toBe(4);

      // Should have been called with correct params
      expect(octokit.gists.create).toHaveBeenCalledWith({
        description: GIST_DESCRIPTION,
        public: false,
        files: {
          [STATE_FILE_NAME]: { content: expect.any(String) },
        },
      });

      // Should have written local gist-id file
      const storedId = fs.readFileSync(path.join(tmpDir, 'gist-id'), 'utf8');
      expect(storedId).toBe(newGistId);

      // Should have written local state cache
      expect(fs.existsSync(path.join(tmpDir, 'state-cache.json'))).toBe(true);
    });
  });

  describe('state parsing and migration', () => {
    it('should migrate v2 state from Gist all the way to v4', async () => {
      const gistId = 'v2-gist';
      const v2State = JSON.stringify({
        version: 2,
        activeIssues: [],
        repoScores: {},
        config: {
          setupComplete: true,
          githubUsername: 'migrated-user',
          maxActivePRs: 10,
          dormantThresholdDays: 30,
          approachingDormantDays: 25,
          maxIssueAgeDays: 90,
          languages: ['typescript'],
          labels: ['good first issue'],
          excludeRepos: [],
          trustedProjects: [],
          minRepoScoreThreshold: 4,
          starredRepos: [],
          squashByDefault: true,
          minStars: 50,
          includeDocIssues: true,
          aiPolicyBlocklist: [],
          shelvedPRUrls: [],
          dismissedIssues: {},
          projectCategories: [],
          preferredOrgs: [],
          // Dead v2 fields that should be stripped
          showHealthCheck: true,
          scoreThreshold: 5,
        },
        lastRunAt: new Date().toISOString(),
        // Dead v2 fields that should be stripped
        events: [{ type: 'test' }],
        dailyActivityCounts: { '2025-01-01': 5 },
      });

      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, v2State));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.state.version).toBe(4);
      expect(result.state.config.githubUsername).toBe('migrated-user');
      expect(result.state.config.setupComplete).toBe(true);
    });

    it('should return fresh state when state.json is missing from Gist', async () => {
      const gistId = 'empty-gist';

      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      // Gist exists but has no state.json file
      octokit.gists.get.mockResolvedValue({
        data: {
          id: gistId,
          description: GIST_DESCRIPTION,
          files: {},
        },
      });

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.state.version).toBe(4);
      expect(result.state.config.setupComplete).toBe(false);
    });

    it('should preserve corrupt content and rethrow GistCorruptError rather than degrade (#1201, #1367)', async () => {
      const gistId = 'corrupt-gist';
      const corruptContent = 'not valid json';

      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, corruptContent));
      octokit.gists.list.mockResolvedValue({ data: [] });

      const store = new GistStateStore(octokit);

      // A corrupt Gist must SURFACE, not degrade (#1367): by the time the
      // parse throws, fetchAndCache has armed gistId + the ETag, so a
      // degraded store could push() fresh state over the corrupt remote —
      // the data-loss scenario #1201 was filed for. Degrading also risks
      // silently abandoning the Gist and creating a fresh one via step 3.
      await expect(store.bootstrap()).rejects.toThrow(GistCorruptError);

      // The corrupt content is still preserved as `.rejected-<ts>` so the
      // user can recover it.
      const rejectedFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith('state-cache.json.rejected-'));
      expect(rejectedFiles.length).toBeGreaterThanOrEqual(1);
      const preservedContent = fs.readFileSync(path.join(tmpDir, rejectedFiles[0]!), 'utf8');
      expect(preservedContent).toBe(corruptContent);
    });

    it('rethrows rate-limit errors instead of degrading (#1367)', async () => {
      // The first gists.list call is checkGistScope's probe — let it succeed
      // so the 429 hits the SEARCH step inside the outer try, exercising the
      // new outer-catch rate-limit rethrow (checkGistScope has its own,
      // pre-existing rethrow). errors.ts's contract is that rate-limit errors
      // always propagate; degrading would present "you are rate-limited" as
      // a stale local cache.
      octokit.gists.list.mockResolvedValueOnce({ data: [] });
      octokit.gists.list.mockRejectedValueOnce(Object.assign(new Error('API rate limit exceeded'), { status: 429 }));

      const store = new GistStateStore(octokit);
      await expect(store.bootstrap()).rejects.toThrow('API rate limit exceeded');
    });

    it('degraded bootstrap disarms the push path (#1367)', async () => {
      // Genuine API unavailability still degrades — but the degraded store
      // never verified its Gist, so it must not be able to push to one.
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), 'unreachable-gist');
      octokit.gists.get.mockRejectedValue(new Error('Network error'));
      octokit.gists.list.mockRejectedValue(new Error('Network error'));
      octokit.gists.create.mockRejectedValue(new Error('Network error'));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.degraded).toBe(true);
      expect(store.getGistId()).toBeNull();

      store.setState(JSON.stringify(createFreshState()));
      await expect(store.push()).rejects.toThrow(/cannot push before bootstrap/);
      expect(octokit.gists.update).not.toHaveBeenCalled();
    });
  });

  describe('in-memory cache', () => {
    it('should initialize dirtyFiles as empty', async () => {
      const gistId = 'dirty-check';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      expect(store.dirtyFiles.size).toBe(0);
    });

    it('should skip null-content files in Gist response', async () => {
      const gistId = 'null-content-gist';

      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue({
        data: {
          id: gistId,
          description: GIST_DESCRIPTION,
          files: {
            [STATE_FILE_NAME]: { filename: STATE_FILE_NAME, content: makeStateJson() },
            'truncated.md': null,
          },
        },
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      expect(store.cachedFiles.size).toBe(1);
      expect(store.cachedFiles.has('truncated.md')).toBe(false);
    });
  });

  describe('refreshFromGist (#1209 L9)', () => {
    it('returns { status: "no-gist" } before bootstrap (no gistId)', async () => {
      const store = new GistStateStore(octokit);
      const result = await store.refreshFromGist();
      expect(result).toEqual({ status: 'no-gist' });
    });

    it('returns { status: "refreshed" } on a successful re-fetch', async () => {
      const gistId = 'refresh-success';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      // Reset the throttle so the refresh isn't blocked.
      (store as unknown as { lastRefreshAt: number }).lastRefreshAt = 0;
      const result = await store.refreshFromGist();
      expect(result).toEqual({ status: 'refreshed' });
    });

    it('returns { status: "throttled", sinceLastMs } when called within 30s of the previous refresh', async () => {
      const gistId = 'refresh-throttled';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      // Reset throttle and do a first refresh to stamp lastRefreshAt.
      (store as unknown as { lastRefreshAt: number }).lastRefreshAt = 0;
      const first = await store.refreshFromGist();
      expect(first.status).toBe('refreshed');
      // Immediate next call is within the 30s throttle window.
      const result = await store.refreshFromGist();
      expect(result.status).toBe('throttled');
      if (result.status === 'throttled') {
        expect(result.sinceLastMs).toBeGreaterThanOrEqual(0);
        expect(result.sinceLastMs).toBeLessThan(30_000);
      }
    });

    it('returns { status: "error", error } when the API call fails', async () => {
      const gistId = 'refresh-error';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValueOnce(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      (store as unknown as { lastRefreshAt: number }).lastRefreshAt = 0;
      // Subsequent fetch fails.
      octokit.gists.get.mockRejectedValueOnce(new Error('Gist API 500'));

      const result = await store.refreshFromGist();
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error.message).toContain('Gist API 500');
      }
    });

    it('a FAILED refresh stamps the throttle too — the next call within 30s is throttled (#1443)', async () => {
      const gistId = 'refresh-error-throttle';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValueOnce(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      (store as unknown as { lastRefreshAt: number }).lastRefreshAt = 0;
      octokit.gists.get.mockRejectedValueOnce(new Error('Gist API 500'));

      const failed = await store.refreshFromGist();
      expect(failed.status).toBe('error');

      // Pre-fix, failures bypassed the throttle entirely: during an outage
      // every SPA poll re-attempted a full fetch immediately.
      const fetchCallsAfterFailure = octokit.gists.get.mock.calls.length;
      const throttled = await store.refreshFromGist();
      expect(throttled.status).toBe('throttled');
      expect(octokit.gists.get.mock.calls.length).toBe(fetchCallsAfterFailure);
    });
  });

  describe('getGistId', () => {
    it('should return null before bootstrap', () => {
      const store = new GistStateStore(octokit);
      expect(store.getGistId()).toBeNull();
    });

    it('should return the Gist ID after bootstrap', async () => {
      const gistId = 'id-after-boot';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      expect(store.getGistId()).toBe(gistId);
    });
  });

  describe('push', () => {
    it('should be a no-op and return true when dirtyFiles is empty', async () => {
      const gistId = 'push-noop';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const result = await store.push();

      expect(result).toBe(true);
      expect(octokit.gists.update).not.toHaveBeenCalled();
    });

    it('should send only dirty files to the Gist', async () => {
      const gistId = 'push-dirty-only';
      const stateJson = makeStateJson();
      const response = makeGistResponse(gistId, stateJson);
      response.data.files['notes.md'] = { filename: 'notes.md', content: '# Notes' };
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(response);

      octokit.gists.update.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      // Mark only state.json dirty — notes.md should not be sent
      store.markDirty(STATE_FILE_NAME);

      await store.push();

      expect(octokit.gists.update).toHaveBeenCalledWith({
        gist_id: gistId,
        files: {
          [STATE_FILE_NAME]: { content: stateJson },
        },
      });
    });

    it('should clear the dirty set on success', async () => {
      const gistId = 'push-clears-dirty';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));
      octokit.gists.update.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      store.markDirty(STATE_FILE_NAME);
      expect(store.dirtyFiles.size).toBe(1);

      const result = await store.push();

      expect(result).toBe(true);
      expect(store.dirtyFiles.size).toBe(0);
    });

    it('should retry once on failure and succeed on the second attempt', async () => {
      const gistId = 'push-retry-success';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));

      // First update call fails, second succeeds
      octokit.gists.update
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      store.markDirty(STATE_FILE_NAME);
      const result = await store.push();

      expect(result).toBe(true);
      expect(octokit.gists.update).toHaveBeenCalledTimes(2);
      expect(store.dirtyFiles.size).toBe(0);
    });

    it('should return false after both attempts fail', async () => {
      const gistId = 'push-retry-fail';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));

      octokit.gists.update
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error again'));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      store.markDirty(STATE_FILE_NAME);
      const result = await store.push();

      expect(result).toBe(false);
      expect(octokit.gists.update).toHaveBeenCalledTimes(2);
      // Dirty set should NOT be cleared on failure
      expect(store.dirtyFiles.size).toBe(1);
    });

    it('should throw when gistId is null', async () => {
      const store = new GistStateStore(octokit);
      store.markDirty(STATE_FILE_NAME);
      store.cachedFiles.set(STATE_FILE_NAME, makeStateJson());

      await expect(store.push()).rejects.toThrow(/gistId is null/);
    });

    it('should write the local state cache after a successful push', async () => {
      const gistId = 'push-writes-cache';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));
      octokit.gists.update.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      // Remove cache file to confirm it gets re-written
      const cachePath = path.join(tmpDir, 'state-cache.json');
      fs.rmSync(cachePath, { force: true });

      store.markDirty(STATE_FILE_NAME);
      await store.push();

      expect(fs.existsSync(cachePath)).toBe(true);
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      expect(cached.version).toBe(4);
    });
  });

  describe('setState', () => {
    it('should update cachedFiles and mark state.json dirty', async () => {
      const gistId = 'set-state-test';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      // Dirty set starts clean after bootstrap
      expect(store.dirtyFiles.size).toBe(0);

      const newStateJson = makeStateJson({ lastRunAt: '2026-01-01T00:00:00.000Z' });
      store.setState(newStateJson);

      expect(store.cachedFiles.get(STATE_FILE_NAME)).toBe(newStateJson);
      expect(store.dirtyFiles.has(STATE_FILE_NAME)).toBe(true);
    });
  });

  describe('getDocument', () => {
    it('should return content from cachedFiles for an existing file', async () => {
      const gistId = 'get-doc-exists';
      const response = makeGistResponse(gistId, makeStateJson());
      response.data.files['guidelines--my-repo.md'] = {
        filename: 'guidelines--my-repo.md',
        content: '# My Repo Guidelines\nBe careful.',
      };
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(response);

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      expect(store.getDocument('guidelines--my-repo.md')).toBe('# My Repo Guidelines\nBe careful.');
    });

    it('should return null for a nonexistent file', async () => {
      const gistId = 'get-doc-missing';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      expect(store.getDocument('guidelines--nonexistent.md')).toBeNull();
    });
  });

  describe('setDocument', () => {
    it('should update cachedFiles and mark the file dirty', async () => {
      const gistId = 'set-doc-test';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      store.setDocument('guidelines--some-repo.md', '# Guidelines\nDo good work.');

      expect(store.cachedFiles.get('guidelines--some-repo.md')).toBe('# Guidelines\nDo good work.');
      expect(store.dirtyFiles.has('guidelines--some-repo.md')).toBe(true);
    });

    it('should include document in push payload after setDocument', async () => {
      const gistId = 'set-doc-push';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));
      octokit.gists.update.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      store.setDocument('guidelines--new-repo.md', '# New Repo\nKeep it simple.');
      await store.push();

      expect(octokit.gists.update).toHaveBeenCalledWith({
        gist_id: gistId,
        files: {
          'guidelines--new-repo.md': { content: '# New Repo\nKeep it simple.' },
        },
      });
    });
  });

  describe('listDocuments', () => {
    it('should return filenames matching the given prefix', async () => {
      const gistId = 'list-docs-prefix';
      const response = makeGistResponse(gistId, makeStateJson());
      response.data.files['guidelines--repo-a.md'] = { filename: 'guidelines--repo-a.md', content: 'a' };
      response.data.files['guidelines--repo-b.md'] = { filename: 'guidelines--repo-b.md', content: 'b' };
      response.data.files['notes--misc.md'] = { filename: 'notes--misc.md', content: 'misc' };
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(response);

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const docs = store.listDocuments('guidelines--');
      expect(docs).toHaveLength(2);
      expect(docs).toContain('guidelines--repo-a.md');
      expect(docs).toContain('guidelines--repo-b.md');
      expect(docs).not.toContain('notes--misc.md');
    });

    it('should return an empty array when no files match the prefix', async () => {
      const gistId = 'list-docs-empty';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      expect(store.listDocuments('guidelines--')).toEqual([]);
    });

    it('should include files added via setDocument', async () => {
      const gistId = 'list-docs-set';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      store.setDocument('guidelines--added-repo.md', '# Added');

      const docs = store.listDocuments('guidelines--');
      expect(docs).toContain('guidelines--added-repo.md');
    });
  });

  describe('graceful degradation', () => {
    it('falls back to local cache when all API calls fail', async () => {
      const cachedState = JSON.parse(makeStateJson({ lastRunAt: '2025-06-01T00:00:00.000Z' }));
      const cachePath = path.join(tmpDir, 'state-cache.json');
      fs.writeFileSync(cachePath, JSON.stringify(cachedState, null, 2));

      // All Octokit methods reject
      octokit.gists.get.mockRejectedValue(new Error('Network error'));
      octokit.gists.list.mockRejectedValue(new Error('Network error'));
      octokit.gists.create.mockRejectedValue(new Error('Network error'));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.degraded).toBe(true);
      expect(result.gistId).toBe('');
      expect(result.created).toBe(false);
      expect(result.state.version).toBe(4);
      expect(result.state.lastRunAt).toBe('2025-06-01T00:00:00.000Z');
    });

    it('returns fresh state when API fails AND no local cache exists', async () => {
      // No cache file written, all API methods reject
      octokit.gists.get.mockRejectedValue(new Error('Network error'));
      octokit.gists.list.mockRejectedValue(new Error('Network error'));
      octokit.gists.create.mockRejectedValue(new Error('Network error'));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.degraded).toBe(true);
      expect(result.gistId).toBe('');
      expect(result.created).toBe(false);
      expect(result.state.version).toBe(4);
      expect(result.state.config.setupComplete).toBe(false);
    });

    it('degraded is true in fallback case', async () => {
      octokit.gists.list.mockRejectedValue(new Error('Unauthorized'));
      octokit.gists.create.mockRejectedValue(new Error('Unauthorized'));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.degraded).toBe(true);
    });

    it('degraded is false/undefined in normal case', async () => {
      const gistId = 'normal-boot';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.degraded).toBeFalsy();
    });
  });

  describe('local state cache validation', () => {
    it('should write a valid AgentState to the local cache file', async () => {
      const gistId = 'validate-cache';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const cachePath = path.join(tmpDir, 'state-cache.json');
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const parsed = AgentStateSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
    });
  });

  describe('bootstrapWithMigration', () => {
    it('creates Gist seeded with existing state when no Gist found', async () => {
      const newGistId = 'migration-created';
      const existingState = createFreshState();
      existingState.config.githubUsername = 'migrated-user';
      existingState.config.setupComplete = true;

      // No local gist-id file, search returns empty
      octokit.gists.list.mockResolvedValue({ data: [] });

      const seededJson = JSON.stringify(existingState, null, 2);
      octokit.gists.create.mockResolvedValue({
        data: {
          id: newGistId,
          description: GIST_DESCRIPTION,
          files: {
            [STATE_FILE_NAME]: { filename: STATE_FILE_NAME, content: seededJson },
          },
        },
      });

      const store = new GistStateStore(octokit);
      const result = await store.bootstrapWithMigration(existingState);

      expect(result.gistId).toBe(newGistId);
      expect(result.created).toBe(true);
      expect(result.migrated).toBe(true);
      expect(result.state.config.githubUsername).toBe('migrated-user');
      expect(result.state.config.setupComplete).toBe(true);

      // Gist was created with the existing state content (not a fresh state)
      expect(octokit.gists.create).toHaveBeenCalledWith({
        description: GIST_DESCRIPTION,
        public: false,
        files: {
          [STATE_FILE_NAME]: { content: seededJson },
        },
      });

      // Local gist-id file should be written
      const storedId = fs.readFileSync(path.join(tmpDir, 'gist-id'), 'utf8');
      expect(storedId).toBe(newGistId);
    });

    it('returns existing Gist when one already exists via local ID (no migration)', async () => {
      const existingGistId = 'already-exists';
      const existingStateJson = makeStateJson({ lastRunAt: '2025-01-01T00:00:00.000Z' });
      const localState = createFreshState();

      // Pre-seed local gist-id
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), existingGistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(existingGistId, existingStateJson));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrapWithMigration(localState);

      expect(result.gistId).toBe(existingGistId);
      expect(result.created).toBe(false);
      expect(result.migrated).toBe(false);
      // State comes from the Gist, not local
      expect(result.state.lastRunAt).toBe('2025-01-01T00:00:00.000Z');

      // Should not have created a new Gist
      expect(octokit.gists.create).not.toHaveBeenCalled();
    });

    it('returns existing Gist found via search (no migration)', async () => {
      const searchGistId = 'found-via-search';
      const existingStateJson = makeStateJson({ lastRunAt: '2025-06-01T00:00:00.000Z' });
      const localState = createFreshState();

      // No local gist-id, but search finds one
      octokit.gists.list.mockResolvedValue({
        data: [{ id: searchGistId, description: GIST_DESCRIPTION }],
      });
      octokit.gists.get.mockResolvedValue(makeGistResponse(searchGistId, existingStateJson));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrapWithMigration(localState);

      expect(result.gistId).toBe(searchGistId);
      expect(result.created).toBe(false);
      expect(result.migrated).toBe(false);
      expect(result.state.lastRunAt).toBe('2025-06-01T00:00:00.000Z');

      expect(octokit.gists.create).not.toHaveBeenCalled();
    });

    it('returns existingState with degraded: true when all API calls fail and no local cache exists', async () => {
      const existingState = createFreshState();
      existingState.config.githubUsername = 'migrated-user';

      // No local gist-id file, no local cache file
      // All Octokit methods reject
      octokit.gists.get.mockRejectedValue(new Error('Network error'));
      octokit.gists.list.mockRejectedValue(new Error('Network error'));
      octokit.gists.create.mockRejectedValue(new Error('Network error'));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrapWithMigration(existingState);

      // Should return the provided existingState (not a fresh state)
      expect(result.state.config.githubUsername).toBe('migrated-user');
      // Should be in degraded mode
      expect(result.degraded).toBe(true);
      expect(result.gistId).toBe('');
      expect(result.created).toBe(false);
      expect(result.migrated).toBe(false);
    });

    it('returns migrated: true for new migration, false when existing Gist found', async () => {
      const localState = createFreshState();

      // Scenario A: new migration
      const newGistId = 'brand-new-gist';
      octokit.gists.list.mockResolvedValue({ data: [] });
      const seededJson = JSON.stringify(localState, null, 2);
      octokit.gists.create.mockResolvedValue({
        data: {
          id: newGistId,
          description: GIST_DESCRIPTION,
          files: {
            [STATE_FILE_NAME]: { filename: STATE_FILE_NAME, content: seededJson },
          },
        },
      });

      const storeA = new GistStateStore(octokit);
      const resultA = await storeA.bootstrapWithMigration(localState);
      expect(resultA.migrated).toBe(true);

      // Scenario B: existing Gist found via local ID
      octokit.gists.get.mockResolvedValue(makeGistResponse('existing-id', makeStateJson()));
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), 'existing-id');

      const storeB = new GistStateStore(octokit);
      const resultB = await storeB.bootstrapWithMigration(localState);
      expect(resultB.migrated).toBe(false);
    });
  });

  describe('ETag-based optimistic concurrency (#1115, #1510)', () => {
    it('never sends an If-Match header on the write even when an ETag was fetched (#1510)', async () => {
      // The Gist PATCH endpoint rejects conditional request headers with HTTP
      // 400, so the captured ETag must not be replayed as `If-Match` on the
      // write. Reads may still capture the ETag, but the write is unconditional.
      const gistId = 'etag-capture';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue({
        ...makeGistResponse(gistId, stateJson),
        headers: { etag: 'W/"abc123"' },
      });
      octokit.gists.update.mockResolvedValue({
        ...makeGistResponse(gistId, stateJson),
        headers: { etag: 'W/"def456"' },
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      store.markDirty(STATE_FILE_NAME);
      const ok = await store.push();

      expect(ok).toBe(true);
      // Exactly gist_id + files — no `headers`/`if-match` field.
      expect(octokit.gists.update).toHaveBeenCalledWith({
        gist_id: gistId,
        files: { [STATE_FILE_NAME]: { content: stateJson } },
      });
      const [params] = octokit.gists.update.mock.calls[0] as [{ headers?: Record<string, string> }];
      expect(params.headers).toBeUndefined();
    });

    it('omits the If-Match header when the SDK does not surface an ETag (test mocks)', async () => {
      const gistId = 'etag-missing';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      // No headers field — represents either a degraded SDK or an old test mock.
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, stateJson));
      octokit.gists.update.mockResolvedValue(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      store.markDirty(STATE_FILE_NAME);
      await store.push();

      expect(octokit.gists.update).toHaveBeenCalledWith({
        gist_id: gistId,
        files: { [STATE_FILE_NAME]: { content: stateJson } },
      });
    });

    it('re-reads before a state.json write and proceeds when state.json is unchanged', async () => {
      // With no If-Match available (#1510), push() re-reads the Gist before a
      // state.json write and compares the remote against its baseline. When
      // state.json is byte-identical there is no conflict, so the write goes
      // through unconditionally.
      const gistId = 'reread-unchanged';
      const stateJson = makeStateJson({ lastRunAt: '2025-01-01T00:00:00.000Z' });
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);

      // Bootstrap fetch (etag v1), then the pre-write re-read (etag v2), both
      // returning identical state.json.
      octokit.gists.get
        .mockResolvedValueOnce({ ...makeGistResponse(gistId, stateJson), headers: { etag: 'W/"v1"' } })
        .mockResolvedValueOnce({ ...makeGistResponse(gistId, stateJson), headers: { etag: 'W/"v2"' } });
      octokit.gists.update.mockResolvedValueOnce({
        ...makeGistResponse(gistId, stateJson),
        headers: { etag: 'W/"v3"' },
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      store.markDirty(STATE_FILE_NAME);
      const ok = await store.push();

      expect(ok).toBe(true);
      // get called twice (bootstrap + pre-write re-read); update called once,
      // unconditionally (no If-Match header).
      expect(octokit.gists.get).toHaveBeenCalledTimes(2);
      expect(octokit.gists.update).toHaveBeenCalledTimes(1);
      expect(octokit.gists.update).toHaveBeenCalledWith({
        gist_id: gistId,
        files: { [STATE_FILE_NAME]: { content: stateJson } },
      });
    });

    it('does not re-read for a freeform-only write (last-write-wins)', async () => {
      // Freeform documents keep last-write-wins: the Gist `files` parameter is
      // a partial update, so a guidelines-only push needs no pre-write
      // re-read and cannot clobber another file.
      const gistId = 'reread-skip-freeform';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);

      octokit.gists.get.mockResolvedValueOnce({
        ...makeGistResponse(gistId, stateJson),
        headers: { etag: 'W/"v1"' },
      });
      octokit.gists.update.mockResolvedValueOnce(makeGistResponse(gistId, stateJson));

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      store.setDocument('guidelines--owner--repo.md', '# Guidelines');
      const ok = await store.push();

      expect(ok).toBe(true);
      // Only the bootstrap fetch — no pre-write re-read for a freeform write.
      expect(octokit.gists.get).toHaveBeenCalledTimes(1);
      expect(octokit.gists.update).toHaveBeenCalledTimes(1);
    });

    it('throws GistConcurrencyError when state.json moved remotely (#1235)', async () => {
      // The pre-write re-read returns a CHANGED state.json, so the fail-loud
      // check fires before any write — the writer sees GistConcurrencyError
      // instead of clobbering the remote edit.
      const gistId = 'reread-state-changed';
      const initialStateJson = makeStateJson({ lastRunAt: '2025-01-01T00:00:00.000Z' });
      const remoteStateJson = makeStateJson({ lastRunAt: '2025-06-01T00:00:00.000Z' });
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);

      octokit.gists.get
        .mockResolvedValueOnce({ ...makeGistResponse(gistId, initialStateJson), headers: { etag: 'W/"v1"' } })
        .mockResolvedValueOnce({ ...makeGistResponse(gistId, remoteStateJson), headers: { etag: 'W/"v2"' } });

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      store.markDirty(STATE_FILE_NAME);

      const { GistConcurrencyError } = await import('./errors.js');
      await expect(store.push()).rejects.toThrow(GistConcurrencyError);

      // The write never fired — the pre-write check threw first.
      expect(octokit.gists.update).not.toHaveBeenCalled();
      // Local state.json mutation is preserved in cachedFiles for the caller
      // to refresh and reapply against the new baseline.
      expect(store.dirtyFiles.has(STATE_FILE_NAME)).toBe(true);
      expect(store.cachedFiles.get(STATE_FILE_NAME)).toBe(initialStateJson);
    });

    it('throws GistConcurrencyError when the pre-write re-read fails', async () => {
      const gistId = 'reread-network-fail';
      const stateJson = makeStateJson();
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);

      octokit.gists.get
        .mockResolvedValueOnce({ ...makeGistResponse(gistId, stateJson), headers: { etag: 'W/"v1"' } })
        .mockRejectedValueOnce(new Error('Network error'));

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      store.markDirty(STATE_FILE_NAME);

      const { GistConcurrencyError } = await import('./errors.js');
      await expect(store.push()).rejects.toThrow(GistConcurrencyError);
      // No write attempted when the conflict check could not complete.
      expect(octokit.gists.update).not.toHaveBeenCalled();
    });

    it('on corrupt remote during the pre-write re-read, rolls back ETag/baseline and propagates GistCorruptError (#1235)', async () => {
      // The pre-write re-read returns a corrupt state.json, so
      // parseStateFromCache throws GistCorruptError after `cachedFiles` /
      // `lastFetchedEtag` were already mutated mid-fetchAndCache. push() rolls
      // those back and re-throws the corrupt error so callers don't retry
      // against a corrupt remote.
      const gistId = 'reread-corrupt';
      const initialStateJson = makeStateJson({ lastRunAt: '2025-01-01T00:00:00.000Z' });
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);

      const corruptStateRaw = '{"unterminated json';
      octokit.gists.get
        .mockResolvedValueOnce({ ...makeGistResponse(gistId, initialStateJson), headers: { etag: 'W/"v1"' } })
        .mockResolvedValueOnce({ ...makeGistResponse(gistId, corruptStateRaw), headers: { etag: 'W/"v2"' } });

      const store = new GistStateStore(octokit);
      await store.bootstrap();
      store.markDirty(STATE_FILE_NAME);

      const { GistCorruptError } = await import('./errors.js');
      await expect(store.push()).rejects.toThrow(GistCorruptError);

      // Rollback invariants: lastFetchedEtag and cached state.json must be
      // restored to their pre-read values so a follow-up push does not blindly
      // succeed against the corrupt remote.
      expect((store as unknown as { lastFetchedEtag: string | null }).lastFetchedEtag).toBe('W/"v1"');
      expect(store.cachedFiles.get(STATE_FILE_NAME)).toBe(initialStateJson);
      expect(octokit.gists.update).not.toHaveBeenCalled();
    });
  });

  describe('integration: full lifecycle — bootstrap, mutate, push, verify', () => {
    it('should bootstrap, mutate state and documents, push, and verify payload', async () => {
      const gistId = 'integration-lifecycle';
      const initialStateJson = makeStateJson({ lastRunAt: '2025-01-01T00:00:00.000Z' });

      // Seed local gist-id so bootstrap takes the fast path (local ID fetch)
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);

      // Build a Gist response that already has a guidelines file
      const response = makeGistResponse(gistId, initialStateJson);
      response.data.files['guidelines--existing-repo.md'] = {
        filename: 'guidelines--existing-repo.md',
        content: '# Existing guidelines',
      };
      octokit.gists.get.mockResolvedValue(response);
      octokit.gists.update.mockResolvedValue(makeGistResponse(gistId, initialStateJson));

      // ── Step 1: Bootstrap ──────────────────────────────────────────
      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      // Verify state is loaded and cached
      expect(result.gistId).toBe(gistId);
      expect(result.state.version).toBe(4);
      expect(result.state.lastRunAt).toBe('2025-01-01T00:00:00.000Z');
      expect(store.cachedFiles.size).toBe(2); // state.json + guidelines--existing-repo.md
      expect(store.dirtyFiles.size).toBe(0);

      // ── Step 2: Mutate state via setState() ────────────────────────
      const updatedStateJson = makeStateJson({ lastRunAt: '2026-03-25T12:00:00.000Z' });
      store.setState(updatedStateJson);

      expect(store.cachedFiles.get(STATE_FILE_NAME)).toBe(updatedStateJson);
      expect(store.dirtyFiles.has(STATE_FILE_NAME)).toBe(true);

      // ── Step 3: Add a new guidelines document via setDocument() ────
      const guidelinesContent = '# Test Repo Guidelines\n\nBe thorough with tests.';
      store.setDocument('guidelines--test--repo.md', guidelinesContent);

      expect(store.cachedFiles.get('guidelines--test--repo.md')).toBe(guidelinesContent);
      expect(store.dirtyFiles.has('guidelines--test--repo.md')).toBe(true);
      // Total dirty: state.json + guidelines--test--repo.md
      expect(store.dirtyFiles.size).toBe(2);

      // ── Step 4: Push ───────────────────────────────────────────────
      const pushResult = await store.push();
      expect(pushResult).toBe(true);

      // ── Step 5: Verify update payload ──────────────────────────────
      expect(octokit.gists.update).toHaveBeenCalledTimes(1);
      expect(octokit.gists.update).toHaveBeenCalledWith({
        gist_id: gistId,
        files: {
          [STATE_FILE_NAME]: { content: updatedStateJson },
          'guidelines--test--repo.md': { content: guidelinesContent },
        },
      });

      // ── Step 6: Verify dirty set is empty after push ───────────────
      expect(store.dirtyFiles.size).toBe(0);

      // ── Step 7: Verify local state cache was updated ───────────────
      const cachePath = path.join(tmpDir, 'state-cache.json');
      expect(fs.existsSync(cachePath)).toBe(true);
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      expect(cached.version).toBe(4);
      expect(cached.lastRunAt).toBe('2026-03-25T12:00:00.000Z');

      // ── Step 8: Verify idempotent push (nothing dirty) ─────────────
      octokit.gists.update.mockClear();
      const secondPush = await store.push();
      expect(secondPush).toBe(true);
      expect(octokit.gists.update).not.toHaveBeenCalled();
    });

    it('should handle the full cycle with bootstrapWithMigration', async () => {
      const newGistId = 'integration-migration';
      const localState = createFreshState();
      localState.config.githubUsername = 'integration-user';
      localState.config.setupComplete = true;

      // No local gist-id, search returns empty => triggers migration-create
      octokit.gists.list.mockResolvedValue({ data: [] });

      const seededJson = JSON.stringify(localState, null, 2);
      octokit.gists.create.mockResolvedValue({
        data: {
          id: newGistId,
          description: GIST_DESCRIPTION,
          files: {
            [STATE_FILE_NAME]: { filename: STATE_FILE_NAME, content: seededJson },
          },
        },
      });
      octokit.gists.update.mockResolvedValue(makeGistResponse(newGistId, seededJson));
      // The push() pre-write re-read (state.json is dirty) fetches the gist;
      // return the seeded state.json so the baseline comparison sees no change.
      octokit.gists.get.mockResolvedValue(makeGistResponse(newGistId, seededJson));

      // ── Bootstrap with migration ──────────────────────────────────
      const store = new GistStateStore(octokit);
      const result = await store.bootstrapWithMigration(localState);

      expect(result.migrated).toBe(true);
      expect(result.created).toBe(true);
      expect(result.state.config.githubUsername).toBe('integration-user');
      expect(store.dirtyFiles.size).toBe(0);

      // ── Mutate and push ────────────────────────────────────────────
      store.setDocument('guidelines--integration--repo.md', '# Integration test guidelines');
      store.setState(makeStateJson({ lastRunAt: '2026-03-25T18:00:00.000Z' }));

      expect(store.dirtyFiles.size).toBe(2);

      const pushResult = await store.push();
      expect(pushResult).toBe(true);
      expect(store.dirtyFiles.size).toBe(0);

      expect(octokit.gists.update).toHaveBeenCalledWith({
        gist_id: newGistId,
        files: {
          [STATE_FILE_NAME]: { content: expect.any(String) },
          'guidelines--integration--repo.md': { content: '# Integration test guidelines' },
        },
      });
    });
  });

  /*
   * Integration test for StateManager.createWithGist is intentionally skipped.
   *
   * createWithGist uses a dynamic `await import('./github.js')` to get the Octokit
   * factory, then calls getOctokit(token) to build a real client. Mocking this in
   * Vitest would require vi.mock('./github.js') at the module level (which would
   * affect all tests in the file) AND also mocking loadState/fs.existsSync for
   * the migration path. The resulting test would be extremely fragile and tightly
   * coupled to internal wiring, providing little value over the unit tests that
   * already cover:
   *   - GistStateStore.bootstrap (all 3 code paths + degraded mode)
   *   - GistStateStore.bootstrapWithMigration (create-with-seed + existing-Gist)
   *   - GistStateStore.setState / setDocument / push (dirty tracking, payload)
   *   - The full lifecycle integration test above (bootstrap -> mutate -> push)
   *
   * If end-to-end coverage of createWithGist is needed in the future, consider
   * extracting the Octokit creation into a seam that can be injected for testing.
   */
});
