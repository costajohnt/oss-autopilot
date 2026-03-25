/**
 * Tests for GistStateStore — bootstrap flow, in-memory cache, and local cache write-through.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GistStateStore, GIST_DESCRIPTION, STATE_FILE_NAME, type OctokitLike } from './gist-state-store.js';
import { AgentStateSchema } from './state-schema.js';
import { createFreshState } from './state-persistence.js';

// ── Mock utils.js to redirect path helpers to temp directories ────────────────

let mockTmpDir = '';

vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
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

/** Build a minimal valid v3 state object as JSON string. */
function makeStateJson(overrides: Record<string, unknown> = {}): string {
  const state = {
    version: 3,
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
function makeMockOctokit(): OctokitLike & {
  gists: {
    get: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
} {
  return {
    gists: {
      get: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
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
      expect(result.state.version).toBe(3);
      expect(octokit.gists.get).toHaveBeenCalledWith({ gist_id: gistId });
      expect(octokit.gists.list).not.toHaveBeenCalled();
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

      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      expect(cached.version).toBe(3);
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
      const storedId = fs.readFileSync(path.join(tmpDir, 'gist-id'), 'utf-8');
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
      expect(result.state.version).toBe(3);

      // Should have written the local gist-id file
      const storedId = fs.readFileSync(path.join(tmpDir, 'gist-id'), 'utf-8');
      expect(storedId).toBe(gistId);

      // Should have written local state cache
      expect(fs.existsSync(path.join(tmpDir, 'state-cache.json'))).toBe(true);
    });

    it('should page through multiple list pages to find the Gist', async () => {
      const gistId = 'page-2-gist';
      const stateJson = makeStateJson();

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
      expect(octokit.gists.list).toHaveBeenCalledTimes(2);
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
      expect(result.state.version).toBe(3);

      // Should have been called with correct params
      expect(octokit.gists.create).toHaveBeenCalledWith({
        description: GIST_DESCRIPTION,
        public: false,
        files: {
          [STATE_FILE_NAME]: { content: expect.any(String) },
        },
      });

      // Should have written local gist-id file
      const storedId = fs.readFileSync(path.join(tmpDir, 'gist-id'), 'utf-8');
      expect(storedId).toBe(newGistId);

      // Should have written local state cache
      expect(fs.existsSync(path.join(tmpDir, 'state-cache.json'))).toBe(true);
    });
  });

  describe('state parsing and migration', () => {
    it('should migrate v2 state from Gist to v3', async () => {
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

      expect(result.state.version).toBe(3);
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

      expect(result.state.version).toBe(3);
      expect(result.state.config.setupComplete).toBe(false);
    });

    it('should return fresh state when state.json contains invalid JSON', async () => {
      const gistId = 'corrupt-gist';

      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, 'not valid json'));

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.state.version).toBe(3);
      expect(result.state.config.setupComplete).toBe(false);
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

  describe('local state cache validation', () => {
    it('should write a valid AgentState to the local cache file', async () => {
      const gistId = 'validate-cache';
      fs.writeFileSync(path.join(tmpDir, 'gist-id'), gistId);
      octokit.gists.get.mockResolvedValue(makeGistResponse(gistId, makeStateJson()));

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const cachePath = path.join(tmpDir, 'state-cache.json');
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      const parsed = AgentStateSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
    });
  });
});
