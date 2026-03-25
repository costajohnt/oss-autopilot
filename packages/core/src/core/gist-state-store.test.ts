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
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      expect(cached.version).toBe(3);
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
