/**
 * Concurrency stress tests for GistStateStore (#1191, #1510).
 *
 * HISTORY: the push path used to enforce optimistic concurrency by replaying
 * the fetched ETag as an `If-Match` header so the Gist API would reject a
 * stale write with 412. That never worked against real GitHub — the Gist
 * `PATCH` endpoint rejects conditional request headers with HTTP 400 (#1510).
 * The header was dropped and concurrency is now enforced client-side: when
 * `state.json` is dirty, `push()` re-reads the Gist and compares the remote
 * `state.json` against the baseline from the last fetch, throwing
 * GistConcurrencyError if it moved under the writer (#1235). Freeform
 * documents keep last-write-wins (the Gist `files` param is a partial update).
 *
 * The stateful mock below tracks an ETag and a (now never-triggered)
 * `If-Match` precondition so the convergence test can assert production never
 * sends the header. `get` always returns the current canonical content, which
 * is what drives the read-before-write conflict detection.
 *
 * `cachedFiles` and `dirtyFiles` are public readonly handles on the store, so
 * the test can mutate them as the app layer does without reaching into private
 * fields.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GistStateStore, GIST_DESCRIPTION, STATE_FILE_NAME, type OctokitLike } from './gist-state-store.js';
import { GistConcurrencyError } from './errors.js';
import { StateManager, maybeCheckpoint } from './state.js';
import { AgentStateSchema, type WorkClaim } from './state-schema.js';
import { claimWork, finishWork, listWork, releaseWork } from '../commands/work.js';

// ── Path mock (shared with gist-state-store.test.ts pattern) ─────────────────

const mockScratch = { dir: '' };

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  return {
    ...actual,
    getDataDir: () => {
      if (!mockScratch.dir) throw new Error('mockScratch.dir not set');
      if (!fs.existsSync(mockScratch.dir)) {
        fs.mkdirSync(mockScratch.dir, { recursive: true, mode: 0o700 });
      }
      return mockScratch.dir;
    },
    getGistIdPath: () => {
      if (!mockScratch.dir) throw new Error('mockScratch.dir not set');
      if (!fs.existsSync(mockScratch.dir)) {
        fs.mkdirSync(mockScratch.dir, { recursive: true, mode: 0o700 });
      }
      return path.join(mockScratch.dir, 'gist-id');
    },
    getStateCachePath: () => {
      if (!mockScratch.dir) throw new Error('mockScratch.dir not set');
      if (!fs.existsSync(mockScratch.dir)) {
        fs.mkdirSync(mockScratch.dir, { recursive: true, mode: 0o700 });
      }
      return path.join(mockScratch.dir, 'state-cache.json');
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
    mockScratch.dir = tmpDir;
    // Pre-seed the local gist-id file so all bootstrap() calls take the
    // "load by ID" path (gist-state-store.ts:148-160) instead of search/create.
    fs.writeFileSync(path.join(tmpDir, 'gist-id'), GIST_ID, { mode: 0o600 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mockScratch.dir = '';
  });

  it("a mutation that conflicts with another machine's push is re-applied on the refreshed baseline, not dropped (audit 2026-10-30 H1)", async () => {
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());

    // Machine A: a long-lived process (MCP server) that bootstrapped at R0.
    const storeA = new GistStateStore(mock.octokit);
    await storeA.bootstrap();
    const machineA = new StateManager(true);
    (machineA as unknown as { state: unknown }).state = AgentStateSchema.parse(
      JSON.parse(storeA.cachedFiles.get(STATE_FILE_NAME)!),
    );
    (machineA as unknown as { gistStore: unknown }).gistStore = storeA;

    // Machine B: pushes R1 (dismisses issue 1) while A is idle.
    const storeB = new GistStateStore(mock.octokit);
    await storeB.bootstrap();
    const stateB = JSON.parse(storeB.cachedFiles.get(STATE_FILE_NAME)!) as {
      config: { dismissedIssues?: Record<string, string> };
    };
    stateB.config.dismissedIssues = { 'https://github.com/o/r/issues/1': '2026-10-30T00:00:00.000Z' };
    storeB.setState(JSON.stringify(stateB));
    expect(await storeB.push()).toBe(true);

    // Machine A dismisses issue 2 against its stale R0 baseline. The push
    // conflicts (R1 != R0); recovery must force-refresh, re-apply, and push
    // a Gist that carries BOTH dismissals.
    const urlA = 'https://github.com/o/r/issues/2';
    machineA.dismissIssue(urlA, '2026-10-30T00:01:00.000Z');
    const warning = await maybeCheckpoint(machineA, 'test', () =>
      machineA.dismissIssue(urlA, '2026-10-30T00:01:00.000Z'),
    );

    expect(warning).toBeNull();
    // B's push plus A's recovered push; A's conflicting first push never wrote.
    expect(mock.counts.update).toBe(2);
    const both = new Set(['https://github.com/o/r/issues/1', 'https://github.com/o/r/issues/2']);
    const remote = mock.readState() as { config: { dismissedIssues: Record<string, string> } };
    expect(new Set(Object.keys(remote.config.dismissedIssues))).toEqual(both);
    expect(new Set(Object.keys(machineA.getState().config.dismissedIssues ?? {}))).toEqual(both);
  });

  it("a work claim pushed from a stale baseline keeps the other machine's claim (#1856, #1852)", async () => {
    const outcome = await runStaleBaselineClaimScenario(GIST_ID);
    expect(outcome.warning).toBeNull();
    expect(outcome.updateCount).toBe(2);
    expect(outcome.remoteClaims).toEqual([
      'machine-b:https://github.com/o/r/issues/1',
      'machine-a:https://github.com/o/r/issues/2',
    ]);
    expect(outcome.localSessions).toEqual(['machine-b', 'machine-a']);
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

    // No update sent an If-Match header — the Gist PATCH endpoint rejects
    // conditional request headers with HTTP 400, so #1510 dropped them.
    const updateMock = vi.mocked(mock.octokit.gists.update);
    for (const call of updateMock.mock.calls) {
      const [params] = call as [{ headers?: Record<string, string> }];
      expect(params.headers).toBeUndefined();
    }
  });

  // NOTE (#1510): the former "loses two consecutive races surfaces
  // GistConcurrencyError" test was removed here. It relied on the writer
  // hitting two consecutive 412s through the mid-push refresh — a path that
  // only existed under the dropped `If-Match` server-side concurrency. The
  // state.json fail-loud guarantee it protected is now covered by the two
  // read-before-write tests below.

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

  // Disjoint freeform writers keep last-write-wins: each writer owns a
  // distinct guidelines file, so even though no `If-Match` is sent (#1510),
  // the Gist `files` partial-update semantics mean neither write clobbers the
  // other and both land.
  it('two writers writing distinct guidelines files both land (last-write-wins)', async () => {
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());
    const a = new GistStateStore(mock.octokit);
    const b = new GistStateStore(mock.octokit);
    await Promise.all([a.bootstrap(), b.bootstrap()]);

    await tryWriteDocument(a, 'guidelines--writer-a.md', 'a content');

    b.setDocument('guidelines--writer-b.md', 'b content');
    await b.push();

    const finalFiles = mock.readAllFiles();
    expect(finalFiles['guidelines--writer-a.md']).toBe('a content');
    expect(finalFiles['guidelines--writer-b.md']).toBe('b content');
  });

  // Pins the per-file conflict policy from #1235 under the read-before-write
  // mechanism (#1510): when two writers modify state.json on the same base,
  // the second writer's pre-write re-read sees the first writer's edit on
  // remote, so it fails loud (GistConcurrencyError) instead of clobbering.
  it('two writers modifying state.json on the same base — second push fails loud (#1235)', async () => {
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());
    const a = new GistStateStore(mock.octokit);
    const b = new GistStateStore(mock.octokit);
    await Promise.all([a.bootstrap(), b.bootstrap()]);

    // a writes url-a; b writes url-b. Both based on the same bootstrap-time
    // base state (no URLs).
    const stateA = JSON.parse(a.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (stateA.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('url-a');
    a.setState(JSON.stringify(stateA, null, 2));
    await a.push();

    const stateB = JSON.parse(b.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (stateB.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('url-b');
    b.setState(JSON.stringify(stateB, null, 2));
    // b's pre-write re-read finds the remote state.json has changed since b's
    // baseline (a's url-a edit), so the store surfaces GistConcurrencyError
    // instead of clobbering.
    await expect(b.push()).rejects.toBeInstanceOf(GistConcurrencyError);

    // Canonical state retains a's write.
    const finalState = mock.readState() as { config: { shelvedPRUrls: string[] } };
    expect(finalState.config.shelvedPRUrls).toEqual(['url-a']);

    // b's local mutation is preserved in memory so the caller can refresh and
    // reapply manually if desired.
    expect(b.dirtyFiles.has(STATE_FILE_NAME)).toBe(true);
    const bStaged = JSON.parse(b.cachedFiles.get(STATE_FILE_NAME)!) as {
      config: { shelvedPRUrls: string[] };
    };
    expect(bStaged.config.shelvedPRUrls).toEqual(['url-b']);
  });

  // A conflicted push must not advance the baseline to the remote it refused
  // to overwrite. Long-lived callers (dashboard flush, MCP tools) re-push
  // without refreshing, and that second push used to pass the comparison and
  // clobber the other writer's edit with the same stale state.
  it('a second push after a conflict still fails loud and keeps the other writer edit', async () => {
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());
    const a = new GistStateStore(mock.octokit);
    const b = new GistStateStore(mock.octokit);
    await Promise.all([a.bootstrap(), b.bootstrap()]);

    const stateA = JSON.parse(a.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (stateA.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('url-a');
    a.setState(JSON.stringify(stateA, null, 2));
    await a.push();

    const stateB = JSON.parse(b.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (stateB.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('url-b');
    b.setState(JSON.stringify(stateB, null, 2));
    await expect(b.push()).rejects.toBeInstanceOf(GistConcurrencyError);
    await expect(b.push()).rejects.toBeInstanceOf(GistConcurrencyError);

    const finalState = mock.readState() as { config: { shelvedPRUrls: string[] } };
    expect(finalState.config.shelvedPRUrls).toEqual(['url-a']);

    // After an explicit refresh the store adopts the remote and can write again.
    await b.refreshFromGist();
    const refreshed = JSON.parse(b.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (refreshed.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('url-b');
    b.setState(JSON.stringify(refreshed, null, 2));
    await expect(b.push()).resolves.toBe(true);
    const merged = mock.readState() as { config: { shelvedPRUrls: string[] } };
    expect(merged.config.shelvedPRUrls).toEqual(['url-a', 'url-b']);
  });

  // Companion: a mixed dirty set (state.json + a guidelines file) fails loud as
  // a whole when state.json conflicted — the pre-write check gates the entire
  // push, so the guidelines file does not land either (#1235, #1510).
  it('mixed dirty set surfaces GistConcurrencyError when state.json conflicted (#1235)', async () => {
    const mock = makeStatefulGistMock(GIST_ID, makeInitialStateJson());
    const peer = new GistStateStore(mock.octokit);
    const writer = new GistStateStore(mock.octokit);
    await Promise.all([peer.bootstrap(), writer.bootstrap()]);

    // Peer pushes a state.json change, moving state.json off the writer's
    // baseline.
    const peerState = JSON.parse(peer.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (peerState.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('peer-url');
    peer.setState(JSON.stringify(peerState, null, 2));
    await peer.push();

    // Writer stages BOTH a guidelines file and a state.json edit on the
    // pre-peer base. The pre-write re-read sees state.json moved under it; per
    // #1235 the whole push fails loud.
    const writerState = JSON.parse(writer.cachedFiles.get(STATE_FILE_NAME)!) as Record<string, unknown>;
    (writerState.config as { shelvedPRUrls: string[] }).shelvedPRUrls.push('writer-url');
    writer.setDocument('guidelines--writer.md', 'writer content');
    writer.setState(JSON.stringify(writerState, null, 2));
    await expect(writer.push()).rejects.toBeInstanceOf(GistConcurrencyError);

    // Canonical state retains peer's write; writer's guidelines did NOT land
    // (the failed push aborted the whole batch).
    const finalState = mock.readState() as { config: { shelvedPRUrls: string[] } };
    expect(finalState.config.shelvedPRUrls).toEqual(['peer-url']);
    expect(mock.readAllFiles()['guidelines--writer.md']).toBeUndefined();
  });
});

// ── Work claims across machines (#1856, #1852) ──────────────────────────────
// Scenario kept out of the describe above, which sits at the per-function
// line ceiling; the case is registered there (sharing the tmp-dir hooks) and
// asserts on what this returns.

async function runStaleBaselineClaimScenario(gistId: string): Promise<{
  warning: string | null;
  updateCount: number;
  remoteClaims: string[];
  localSessions: string[];
}> {
  const mock = makeStatefulGistMock(gistId, makeInitialStateJson());
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + 3_600_000);
  const claimFor = (url: string, session: string) => ({
    url,
    session,
    kind: 'implementation' as const,
    startedAt: startedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: 'running' as const,
    worktree: `/work/wt/${session}`,
  });

  // Machine A bootstrapped at R0.
  const storeA = new GistStateStore(mock.octokit);
  await storeA.bootstrap();
  const machineA = new StateManager(true);
  (machineA as unknown as { state: unknown }).state = AgentStateSchema.parse(
    JSON.parse(storeA.cachedFiles.get(STATE_FILE_NAME)!),
  );
  (machineA as unknown as { gistStore: unknown }).gistStore = storeA;

  // Machine B claims issue 1 and pushes R1 while A is idle.
  const storeB = new GistStateStore(mock.octokit);
  await storeB.bootstrap();
  const stateB = JSON.parse(storeB.cachedFiles.get(STATE_FILE_NAME)!) as { workClaims?: unknown[] };
  stateB.workClaims = [claimFor('https://github.com/o/r/issues/1', 'machine-b')];
  storeB.setState(JSON.stringify(stateB));
  expect(await storeB.push()).toBe(true);

  // Machine A claims issue 2 against its stale R0 baseline (no claims). The
  // conflicting push must be recovered by re-applying the upsert on B's
  // state, so the Gist ends up with BOTH claims.
  const claimA = claimFor('https://github.com/o/r/issues/2', 'machine-a');
  machineA.upsertWorkClaim(claimA);
  const warning = await maybeCheckpoint(machineA, 'test', () => machineA.upsertWorkClaim(claimA));

  const remote = mock.readState() as { workClaims: Array<{ url: string; session: string }> };
  return {
    warning,
    updateCount: mock.counts.update,
    remoteClaims: remote.workClaims.map((c) => `${c.session}:${c.url}`),
    localSessions: machineA.getActiveWorkClaims().map((c) => c.session),
  };
}

// ── Work claims through the command path, two machines (#1856, #1852) ───────
// Own describe (the one above sits at the per-function line ceiling) with the
// same tmp-dir hooks. Each machine is a StateManager wired to its own
// GistStateStore over one stateful mock, driven through the real `work`
// commands (`claimWork` etc. take the manager explicitly).

const WORK_GIST_ID = 'gist-work-claims-test';
const SESSION_A = 'machine-a/1';
const SESSION_B = 'machine-b/1';
const SESSION_C = 'machine-c/1';

function issue(n: number): string {
  return `https://github.com/o/r/issues/${n}`;
}

function liveClaim(url: string, session: string, worktree: string): WorkClaim {
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + 3_600_000);
  return {
    url,
    session,
    worktree,
    kind: 'implementation',
    status: 'running',
    startedAt: startedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

/** R0 with `claims` already recorded, as a Gist another machine wrote earlier. */
function initialStateWithClaims(claims: WorkClaim[]): string {
  const state = JSON.parse(makeInitialStateJson()) as { workClaims?: WorkClaim[] };
  state.workClaims = claims;
  return JSON.stringify(state, null, 2);
}

/** A fresh process on one machine: bootstraps from the Gist and holds that copy. */
async function attachMachine(mock: StatefulGistMock): Promise<{ machine: StateManager; store: GistStateStore }> {
  const store = new GistStateStore(mock.octokit);
  await store.bootstrap();
  const machine = new StateManager(true);
  (machine as unknown as { state: unknown }).state = AgentStateSchema.parse(
    JSON.parse(store.cachedFiles.get(STATE_FILE_NAME)!),
  );
  (machine as unknown as { gistStore: unknown }).gistStore = store;
  return { machine, store };
}

/** `session:url:status` per claim in the Gist, in stored order. */
function remoteClaims(mock: StatefulGistMock): string[] {
  const remote = mock.readState() as { workClaims: Array<{ url: string; session: string; status: string }> };
  return remote.workClaims.map((c) => `${c.session}:${c.url}:${c.status}`);
}

function implementation(url: string, session: string, worktree: string, isTakeover = false) {
  return { url, session, worktree, kind: 'implementation' as const, ...(isTakeover && { takeover: true }) };
}

describe('work claims across machines through the work commands (#1856, #1852)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-store-work-claims-'));
    mockScratch.dir = tmpDir;
    fs.writeFileSync(path.join(tmpDir, 'gist-id'), WORK_GIST_ID, { mode: 0o600 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mockScratch.dir = '';
  });

  it('both at cap-1 claiming different issues: the one whose push conflicts is refused and records nothing', async () => {
    const seeded = liveClaim(issue(0), SESSION_C, '/work/wt/c');
    const mock = makeStatefulGistMock(WORK_GIST_ID, initialStateWithClaims([seeded]));
    const { machine: a } = await attachMachine(mock);
    const { machine: b } = await attachMachine(mock);
    const claimB = implementation(issue(1), SESSION_B, '/work/wt/b');
    const claimA = implementation(issue(2), SESSION_A, '/work/wt/a');

    await expect(claimWork(b, claimB)).resolves.toMatchObject({ outcome: 'claimed', synced: true });
    // A passed its local check (one running) but the Gist now has two.
    await expect(claimWork(a, claimA)).rejects.toThrow(
      /Implementation cap reached: 2 of 2 running .*this claim was not saved/,
    );

    expect(remoteClaims(mock)).toEqual([`${SESSION_C}:${issue(0)}:running`, `${SESSION_B}:${issue(1)}:running`]);
    // A holds the Gist's copy, without its own claim, and has nothing waiting to push.
    expect(a.getActiveWorkClaims().map((c) => c.session)).toEqual([SESSION_C, SESSION_B]);
    expect(a.hasUnpushedChanges()).toBe(false);
  });

  it('both claiming the same issue: the second is refused unless it takes over, and then replaces the first', async () => {
    const mock = makeStatefulGistMock(WORK_GIST_ID, makeInitialStateJson());
    const { machine: a } = await attachMachine(mock);
    const { machine: b } = await attachMachine(mock);
    const claimB = implementation(issue(1), SESSION_B, '/work/wt/b');
    const claimA = implementation(issue(1), SESSION_A, '/work/wt/a');
    const takeoverA = implementation(issue(1), SESSION_A, '/work/wt/a', true);

    await claimWork(b, claimB);
    await expect(claimWork(a, claimA)).rejects.toThrow(
      new RegExp(`already claimed: implementation claimed in session ${SESSION_B} .*this claim was not saved`),
    );
    expect(remoteClaims(mock)).toEqual([`${SESSION_B}:${issue(1)}:running`]);

    const taken = await claimWork(a, takeoverA);
    expect(taken.outcome).toBe('took-over');
    expect(taken.synced).toBe(true);
    expect(remoteClaims(mock)).toEqual([`${SESSION_A}:${issue(1)}:running`]);
  });

  it('work list refreshes to see a claim pushed after this machine loaded, and flags a failed refresh as stale', async () => {
    const mock = makeStatefulGistMock(WORK_GIST_ID, makeInitialStateJson());
    const { machine: a, store: storeA } = await attachMachine(mock);
    const { machine: b } = await attachMachine(mock);
    const bypassThrottle = () => {
      (storeA as unknown as { lastRefreshAt: number }).lastRefreshAt = 0;
    };

    await claimWork(b, implementation(issue(1), SESSION_B, '/work/wt/b'));
    bypassThrottle();
    const fresh = await listWork(a);
    expect(fresh.claims.map((c) => c.url)).toEqual([issue(1)]);
    expect(fresh.warnings).toBeUndefined();

    // B records a second claim, then A's refresh fails: A serves its copy and says so.
    await claimWork(b, implementation(issue(2), SESSION_B, '/work/wt/b2'));
    vi.mocked(mock.octokit.gists.get).mockRejectedValueOnce(new Error('ECONNRESET while fetching gist'));
    bypassThrottle();
    const stale = await listWork(a);
    expect(stale.claims.map((c) => c.url)).toEqual([issue(1)]);
    expect(stale.warnings).toHaveLength(1);
    expect(stale.warnings?.[0]).toMatchObject({ phase: 'gist-staleness', operation: 'state refresh' });
    expect(stale.warnings?.[0].message).toContain('ECONNRESET while fetching gist');
  });

  it('finish and release re-applied after a conflict change only their own URL', async () => {
    const seeded = liveClaim(issue(1), SESSION_A, '/work/wt/a');
    const mock = makeStatefulGistMock(WORK_GIST_ID, initialStateWithClaims([seeded]));
    const { machine: a } = await attachMachine(mock);
    const { machine: b } = await attachMachine(mock);

    // B adds issue 2; A's finish of issue 1 then conflicts and is re-applied on B's copy.
    await claimWork(b, implementation(issue(2), SESSION_B, '/work/wt/b'));
    const finished = await finishWork(a, { url: issue(1), session: SESSION_A });
    expect(finished.claim?.status).toBe('finished');
    expect(finished.gistSyncWarning).toBeUndefined();
    expect(remoteClaims(mock)).toEqual([`${SESSION_A}:${issue(1)}:finished`, `${SESSION_B}:${issue(2)}:running`]);

    // Now B is stale (A pushed since); its release of issue 2 conflicts and keeps A's finished claim.
    const released = await releaseWork(b, { url: issue(2) });
    expect(released.released).toEqual([issue(2)]);
    expect(released.gistSyncWarning).toBeUndefined();
    expect(remoteClaims(mock)).toEqual([`${SESSION_A}:${issue(1)}:finished`]);
  });
});
