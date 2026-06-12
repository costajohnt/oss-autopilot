/**
 * Concurrency stress tests for GistStateStore (#1191).
 *
 * The production push path implements optimistic concurrency via ETag /
 * `If-Match` and a single merge-and-retry on 412 (gist-state-store.ts:401-429).
 * The existing tests cover the happy path and a single collision; this file
 * exercises sustained contention by driving N stores against one stateful
 * mock Gist that increments its ETag on every update and rejects writes whose
 * `If-Match` doesn't match the current ETag.
 *
 * Key observations from the production code:
 * - `push()` does NOT field-merge. On 412 it re-fetches (which wipes the
 *   cache, line 506) then re-applies the staged dirty contents on top
 *   (lines 408-423). For two writers to both survive a contended push, each
 *   must re-read the freshly-fetched state and re-apply its own mutation
 *   to the new base — same loop the app-level code already runs.
 * - The merge-and-retry is single-shot: after the second 412, push throws
 *   `GistConcurrencyError` (line 427) without further retries. This file
 *   pins that retry bound.
 * - `cachedFiles` and `dirtyFiles` are public readonly handles on the store
 *   (gist-state-store.ts:122-123), so the test can mutate them as the app
 *   layer does without reaching into private fields.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GistStateStore, GIST_DESCRIPTION, STATE_FILE_NAME, type OctokitLike } from './gist-state-store.js';
import { GistConcurrencyError } from './errors.js';

// ── Path mock (shared with gist-state-store.test.ts pattern) ─────────────────

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

function makeInitialStateJson(): string {
  return JSON.stringify(
    {
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
    },
    null,
    2,
  );
}

/**
 * Stateful in-process Gist mock. Holds the canonical state.json content + an
 * ETag that bumps on every successful update. Rejects updates whose
 * `If-Match` header doesn't match the current ETag (412).
 */
interface StatefulGistMock {
  octokit: OctokitLike;
  /** Counts that are kept in closure-scope so writers can read them. */
  counts: { readonly update: number; readonly get: number };
  /** Current state.json content as parsed by the test. */
  readState(): unknown;
  /** Snapshot of every file currently in the gist. */
  readAllFiles(): Record<string, string>;
  /** Current ETag (test-side observation only). */
  currentEtag(): string;
}

function makeStatefulGistMock(gistId: string, initialStateJson: string): StatefulGistMock {
  let etagCounter = 0;
  let currentEtag = `W/"e${etagCounter}"`;
  const files: Record<string, string> = { [STATE_FILE_NAME]: initialStateJson };
  let updateCalls = 0;
  let getCalls = 0;

  const buildResponse = () => ({
    data: {
      id: gistId,
      description: GIST_DESCRIPTION,
      files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, { filename: n, content: c }])),
    },
    headers: { etag: currentEtag },
  });

  const octokit: OctokitLike = {
    gists: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      get: vi.fn(async ({ gist_id }) => {
        if (gist_id !== gistId) {
          throw new Error(`gist mock received unexpected gist_id: got ${gist_id}, expected ${gistId}`);
        }
        getCalls++;
        return buildResponse();
      }),
      update: vi.fn(
        async ({
          gist_id,
          files: incoming,
          headers,
        }: {
          gist_id: string;
          files: Record<string, { content: string }>;
          headers?: Record<string, string>;
        }) => {
          if (gist_id !== gistId) {
            throw new Error(`gist mock received unexpected gist_id: got ${gist_id}, expected ${gistId}`);
          }
          updateCalls++;
          const ifMatch = headers?.['if-match'];
          if (ifMatch !== undefined && ifMatch !== currentEtag) {
            throw Object.assign(new Error('Precondition failed'), { status: 412 });
          }
          for (const [filename, file] of Object.entries(incoming)) {
            files[filename] = file.content;
          }
          etagCounter++;
          currentEtag = `W/"e${etagCounter}"`;
          return buildResponse();
        },
      ),
      create: vi.fn(),
    },
  };

  return {
    octokit,
    counts: {
      get update() {
        return updateCalls;
      },
      get get() {
        return getCalls;
      },
    },
    readState: () => JSON.parse(files[STATE_FILE_NAME]),
    readAllFiles: () => ({ ...files }),
    currentEtag: () => currentEtag,
  };
}

/**
 * App-level retry loop for a writer that owns a single freeform document and
 * pushes via `setDocument(filename, content)` + `push()`. Under contention
 * `push()` may surface `GistConcurrencyError` after its single inner retry —
 * the outer loop refreshes (bypassing the 30s throttle, which guards against
 * runaway polling, not stress-test bursts) and tries once more.
 *
 * Why setDocument and not setState: the production push() does a byte-level
 * overwrite per dirty file (gist-state-store.ts:367-394), so two concurrent
 * writers each setting their own DIFFERENT filename are merge-safe — neither
 * file appears in the other writer's dirty set, and the GitHub Gist API treats
 * the `files` parameter as a partial update. Writes to the SAME state.json
 * file with disjoint fields are NOT merge-safe in this code path; that's a
 * known limitation of the byte-level merge model and out of scope for #1191.
 */
async function tryWriteDocument(
  store: GistStateStore,
  filename: string,
  content: string,
  options: { maxOuterAttempts?: number; bypassRefreshThrottle?: boolean } = {},
): Promise<void> {
  const { maxOuterAttempts = 8, bypassRefreshThrottle = false } = options;
  for (let attempt = 0; attempt < maxOuterAttempts; attempt++) {
    if (attempt > 0) {
      // Default: respect the production throttle so this helper exercises the
      // real refresh path. Tests that drive enough contention to need >1
      // refresh per writer within 30s opt in via `bypassRefreshThrottle`.
      if (bypassRefreshThrottle) {
        (store as unknown as { lastRefreshAt: number }).lastRefreshAt = 0;
      }
      const refreshed = await store.refreshFromGist();
      if (refreshed.status !== 'refreshed') {
        throw new Error(`refreshFromGist returned ${refreshed.status} during retry loop`);
      }
    }
    store.setDocument(filename, content);
    try {
      await store.push();
      return;
    } catch (err) {
      if (err instanceof GistConcurrencyError) continue;
      throw err;
    }
  }
  throw new Error(`writer exhausted ${maxOuterAttempts} outer retries on ${filename}`);
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('GistStateStore concurrency (#1191)', () => {
  let tmpDir: string;
  const GIST_ID = 'gist-concurrency-test';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-store-concurrency-'));
    mockTmpDir = tmpDir;
    // Pre-seed the local gist-id file so all bootstrap() calls take the
    // "load by ID" path (gist-state-store.ts:148-160) instead of search/create.
    fs.writeFileSync(path.join(tmpDir, 'gist-id'), GIST_ID, { mode: 0o600 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('N concurrent writers writing disjoint freeform files all converge', async () => {
    const N = 8;
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());
    const stores: GistStateStore[] = [];
    for (let i = 0; i < N; i++) {
      const store = new GistStateStore(mock.octokit);
      await store.bootstrap();
      stores.push(store);
    }

    // Each writer owns a distinct file so production's per-file byte-overwrite
    // merge is safe by construction — neither writer's file appears in the
    // other writer's dirty set, and Gist's `files` parameter is partial-update.
    // Bypass the 30s refresh throttle: 8 writers contending in a single
    // microtask burst can need >1 refresh each well inside the throttle
    // window, so the throttle would block legitimate retries here. The
    // separate "respects throttle" test below pins the throttle path.
    const writers = stores.map((store, i) =>
      tryWriteDocument(store, `guidelines--writer-${i}.md`, `content from writer ${i}`, {
        bypassRefreshThrottle: true,
      }),
    );

    const results = await Promise.allSettled(writers);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(
      rejected,
      `Expected all ${N} writers to succeed; rejected: ${rejected
        .map((r) => (r as PromiseRejectedResult).reason)
        .join(' | ')}`,
    ).toEqual([]);

    // Final canonical state has every writer's file.
    const finalFiles = mock.readAllFiles();
    for (let i = 0; i < N; i++) {
      expect(finalFiles[`guidelines--writer-${i}.md`]).toBe(`content from writer ${i}`);
    }
    // state.json is preserved (no writer touched it).
    expect(finalFiles[STATE_FILE_NAME]).toBeDefined();

    // Bounded HTTP calls: each push() makes at most two attempts before
    // surfacing a GistConcurrencyError. With at most 8 outer retries per
    // writer, the worst case is 8 (writers) * 8 (outer attempts) * 2 (inner
    // attempts) = 128 update calls. Empirical convergence is far lower; this
    // is a generous ceiling that catches runaway retry loops.
    expect(mock.counts.update).toBeGreaterThanOrEqual(N);
    expect(mock.counts.update).toBeLessThanOrEqual(16 * N);

    // Every update sent an If-Match header — the mock always issues an ETag
    // and bootstrap captures it.
    const updateMock = vi.mocked(mock.octokit.gists.update);
    for (const call of updateMock.mock.calls) {
      const [params] = call as [{ headers?: Record<string, string> }];
      expect(params.headers?.['if-match']).toBeTruthy();
    }
  });

  it('a writer that loses two consecutive races surfaces GistConcurrencyError', async () => {
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());

    const victim = new GistStateStore(mock.octokit);
    const ghostA = new GistStateStore(mock.octokit);
    const ghostB = new GistStateStore(mock.octokit);
    await Promise.all([victim.bootstrap(), ghostA.bootstrap(), ghostB.bootstrap()]);

    // Phase 1: ghost A pushes a guidelines file. Bumps mock ETag, leaving
    // victim's lastFetchedEtag stale.
    await tryWriteDocument(ghostA, 'guidelines--ghost-a.md', 'a content');

    // Phase 2: stage the victim's mutation. Doesn't touch the wire yet.
    victim.setDocument('guidelines--victim.md', 'victim content');

    // Phase 3: hook the mock so the get call inside victim's mid-push refresh
    // (gist-state-store.ts:415) does NOT resolve until ghostB's full push has
    // landed. The captured `response` snapshot still has the pre-ghostB ETag
    // and content, so victim's fetchAndCache writes a stale ETag into
    // `lastFetchedEtag`. Victim's inner retry at line 424 then 412s against
    // ghostB's bumped canonical ETag. That's how we force two consecutive
    // 412s for the same writer in single-threaded JS.
    const realGet = mock.octokit.gists.get;
    let getCallCount = 0;
    mock.octokit.gists.get = vi.fn(async (params) => {
      getCallCount++;
      const response = await realGet(params);
      if (getCallCount === 1) {
        await tryWriteDocument(ghostB, 'guidelines--ghost-b.md', 'b content');
      }
      return response;
    });

    await expect(victim.push()).rejects.toBeInstanceOf(GistConcurrencyError);

    // Pinned retry bound: push() makes exactly two attempts before throwing
    // (gist-state-store.ts:425-428). Local mutation stays staged so the caller
    // can refresh + retry at app level.
    expect(victim.dirtyFiles.has('guidelines--victim.md')).toBe(true);

    // Both ghosts landed; the victim did not.
    const finalFiles = mock.readAllFiles();
    expect(finalFiles['guidelines--ghost-a.md']).toBe('a content');
    expect(finalFiles['guidelines--ghost-b.md']).toBe('b content');
    expect(finalFiles['guidelines--victim.md']).toBeUndefined();
  });

  it('after a contended push sequence, refreshFromGist returns the canonical state', async () => {
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());
    const a = new GistStateStore(mock.octokit);
    const b = new GistStateStore(mock.octokit);
    await Promise.all([a.bootstrap(), b.bootstrap()]);

    await tryWriteDocument(a, 'guidelines--a.md', 'a content');
    await tryWriteDocument(b, 'guidelines--b.md', 'b content');

    // Both stores were constructed with lastRefreshAt=0 so the first refresh
    // always passes the 30s throttle.
    await Promise.all([a.refreshFromGist(), b.refreshFromGist()]);

    const canonical = mock.readAllFiles();
    for (const filename of Object.keys(canonical)) {
      expect(a.cachedFiles.get(filename)).toBe(canonical[filename]);
      expect(b.cachedFiles.get(filename)).toBe(canonical[filename]);
    }
  });

  // Pins the per-file conflict policy from #1235: state.json fails loud
  // when its remote copy moved under the writer (preserving the
  // StateManager optimistic-concurrency contract documented in
  // state.ts:285-296). Two writers each modifying state.json on the same
  // base no longer clobber silently — the second writer's push throws
  // GistConcurrencyError and leaves the canonical state holding the first
  // writer's edit.
  it('two writers modifying state.json on the same base — second push fails loud (#1235)', async () => {
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());
    const a = new GistStateStore(mock.octokit);
    const b = new GistStateStore(mock.octokit);
    await Promise.all([a.bootstrap(), b.bootstrap()]);

    // a writes URL_a; b writes URL_b. Both based on the same bootstrap-time
    // base state (no URLs).
    const stateA = JSON.parse(a.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (stateA.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('url-a');
    a.setState(JSON.stringify(stateA, null, 2));
    await a.push();

    const stateB = JSON.parse(b.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (stateB.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('url-b');
    b.setState(JSON.stringify(stateB, null, 2));
    // b's first push 412s. The merge re-fetches and finds the remote
    // state.json has changed since b's baseline (a's url-a edit), so the
    // store surfaces GistConcurrencyError instead of clobbering.
    await expect(b.push()).rejects.toBeInstanceOf(GistConcurrencyError);

    // Canonical state retains a's write.
    const finalState = mock.readState() as { config: { shelvedPRUrls: string[] } };
    expect(finalState.config.shelvedPRUrls).toEqual(['url-a']);

    // b's local mutation is preserved in memory so the caller can refresh
    // and reapply manually if desired.
    expect(b.dirtyFiles.has(STATE_FILE_NAME)).toBe(true);
    const bStaged = JSON.parse(b.cachedFiles.get(STATE_FILE_NAME)!) as {
      config: { shelvedPRUrls: string[] };
    };
    expect(bStaged.config.shelvedPRUrls).toEqual(['url-b']);
  });

  // Companion to the test above: per-file policy means freeform documents
  // (guidelines, etc.) keep last-write-wins on the same merge re-apply
  // path (#1235). A writer racing on a guidelines file with no concurrent
  // state.json change still succeeds via the existing merge-and-retry.
  it('guidelines writes keep last-write-wins even when a state.json baseline changed (#1235)', async () => {
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());
    const a = new GistStateStore(mock.octokit);
    const b = new GistStateStore(mock.octokit);
    await Promise.all([a.bootstrap(), b.bootstrap()]);

    // a writes a guidelines file. Bumps mock ETag so b's lastFetchedEtag
    // is now stale, but state.json has not changed remotely.
    await tryWriteDocument(a, 'guidelines--writer-a.md', 'a content');

    // b stages a different guidelines file. Its first push 412s; the
    // merge refresh sees state.json baseline unchanged (a only touched
    // a guidelines file), so b's push succeeds on the inner retry.
    b.setDocument('guidelines--writer-b.md', 'b content');
    await b.push();

    const finalFiles = mock.readAllFiles();
    expect(finalFiles['guidelines--writer-a.md']).toBe('a content');
    expect(finalFiles['guidelines--writer-b.md']).toBe('b content');
  });

  // Concurrent state.json + guidelines writes from a single store: when a
  // peer writes state.json between the writer's last fetch and its push,
  // the writer's state.json edit must fail loud even though guidelines
  // would otherwise be safe to reapply. This pins that the per-file check
  // gates the whole push, not just the state.json file (#1235).
  it('mixed dirty set surfaces GistConcurrencyError when state.json conflicted (#1235)', async () => {
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());
    const peer = new GistStateStore(mock.octokit);
    const writer = new GistStateStore(mock.octokit);
    await Promise.all([peer.bootstrap(), writer.bootstrap()]);

    // Peer pushes a state.json change, bumping the canonical ETag and
    // moving state.json off the writer's baseline.
    const peerState = JSON.parse(peer.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (peerState.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('peer-url');
    peer.setState(JSON.stringify(peerState, null, 2));
    await peer.push();

    // Writer stages BOTH a guidelines file and a state.json edit on the
    // pre-peer base. The 412 merge refresh sees state.json moved under
    // it; per #1235 the whole push fails loud.
    const writerState = JSON.parse(writer.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (writerState.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('writer-url');
    writer.setDocument('guidelines--writer.md', 'writer content');
    writer.setState(JSON.stringify(writerState, null, 2));
    await expect(writer.push()).rejects.toBeInstanceOf(GistConcurrencyError);

    // Canonical state retains peer's write; writer's guidelines did NOT
    // land (the failed push aborted the whole batch).
    const finalState = mock.readState() as { config: { shelvedPRUrls: string[] } };
    expect(finalState.config.shelvedPRUrls).toEqual(['peer-url']);
    expect(mock.readAllFiles()['guidelines--writer.md']).toBeUndefined();
  });
});
