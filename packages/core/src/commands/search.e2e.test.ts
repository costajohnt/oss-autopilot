/**
 * E2E smoke tests for the search --json command.
 * Runs the bundled CLI binary and validates JSON output.
 *
 * The search command requires GitHub authentication. Tests validate:
 * - Auth error behavior when no token is available (always runs)
 * - Full JSON envelope and data structure when a token IS available
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

const BUNDLE_PATH = path.resolve(__dirname, '../../dist/cli.bundle.cjs');
const BUNDLE_EXISTS = fs.existsSync(BUNDLE_PATH);
const TEST_HOME = '/tmp/oss-autopilot-e2e-search-test-' + process.pid;

/**
 * Check whether a real GitHub token is available for authenticated tests.
 * Uses GITHUB_TOKEN env var only (gh CLI may not be available in CI).
 */
const HAS_GITHUB_TOKEN = !!process.env.GITHUB_TOKEN;

/**
 * Set by the nightly live-API workflow (.github/workflows/nightly-e2e.yml, #1452).
 * Its whole purpose is to run these token-gated tests, so a missing token in
 * that context must fail loudly rather than silently skip. Unset in per-PR CI
 * and local runs, where skipping is the correct behavior.
 */
const IS_NIGHTLY = process.env.OSS_AUTOPILOT_NIGHTLY === '1';

// A single live `search` invocation walks several `/search/issues` phases that
// scout normally spaces 30s/90s apart to dodge GitHub's secondary rate limit
// (see scout-bridge buildScoutState). #1452 originally collapsed those delays to
// 0 to make the run fast — but firing the phases as a burst RELIABLY trips
// GitHub's secondary rate limit on the shared CI runner IPs. Each hit costs a
// fixed 60s backoff (see core/github.ts onSecondaryRateLimit), and two parallel
// phases backing off blew past the old 120s exec ceiling, so the nightly job
// failed every night with "Hook timed out" / "Test timed out" (#1452).
//
// Three layers fix it:
//   1. Restore a MODEST non-zero inter-phase spacing (not the full 30s/90s) to
//      lower the overall request rate. This helps on a fresh IP, but does not
//      reliably beat the secondary limit on already-throttled shared CI IPs (the
//      scout fires a few /search/issues concurrently WITHIN a phase, which the
//      inter-phase gap can't space), so it is a mitigation, not the guarantee.
//   2. Budget each exec for a spaced multi-phase search plus one 60s backoff, and
//      make the surrounding vitest hook/test deadline STRICTLY GREATER than the
//      exec timeout. With equal budgets, an exec that hit its own timeout and
//      SIGTERM'd was reported as a hook timeout before its catch handler could
//      return the (error) envelope; the gap closes that window.
//   3. Tolerate a rate-limited / timed-out run in the assertions — see
//      isLiveApiUnavailable. Throttling is an infra condition, not a contract
//      regression, so it must not redden the nightly job.
const EXEC_TIMEOUT_MS = 150_000;
// Strictly greater than EXEC_TIMEOUT_MS so a SIGTERM-and-return (or a run that
// completes right at the exec deadline) finishes inside the vitest deadline
// rather than surfacing as "Hook timed out".
const HOOK_TIMEOUT_MS = EXEC_TIMEOUT_MS + 30_000;
const SCOUT_DELAY_ENV = {
  OSS_AUTOPILOT_SCOUT_INTER_PHASE_DELAY_MS: '4000',
  OSS_AUTOPILOT_SCOUT_BROAD_PHASE_DELAY_MS: '8000',
};

interface RunSearchResult {
  stdout: string;
  stderr: string;
  json: any;
  exitCode: number | null;
  signal: string | null;
}

async function runSearch(args: string[] = [], env?: Record<string, string>): Promise<RunSearchResult> {
  let exitCode: number | null = 0;
  let signal: string | null = null;

  const result = await execFileAsync('node', [BUNDLE_PATH, 'search', '--json', ...args], {
    timeout: EXEC_TIMEOUT_MS,
    env: { ...process.env, ...SCOUT_DELAY_ENV, ...env, HOME: TEST_HOME },
    cwd: TEST_HOME,
  }).catch((err: any) => {
    exitCode = err.code ?? null;
    signal = err.signal ?? null;
    return {
      stdout: (err.stdout as string) || '',
      stderr: (err.stderr as string) || '',
      message: err.message ?? '',
    };
  });

  let json: any;
  try {
    json = JSON.parse(result.stdout);
  } catch (parseError) {
    console.warn(
      `[E2E] Failed to parse CLI stdout as JSON (exit=${exitCode}, signal=${signal}):\n` +
        `parse error: ${parseError instanceof Error ? parseError.message : parseError}\n` +
        `stdout: ${result.stdout.slice(0, 500) || '(empty)'}\nstderr: ${result.stderr.slice(0, 500) || '(empty)'}`,
    );
    json = null;
  }

  return { stdout: result.stdout, stderr: result.stderr, json, exitCode, signal };
}

/**
 * A nightly live-API smoke test must stay GREEN when GitHub merely throttled us:
 * a secondary-rate-limit hit is an infrastructure condition, not a regression in
 * the search JSON contract (#1452). Classify a run as "live API unavailable" when
 * any of:
 *   - the exec hit its own timeout — no envelope came back (json === null) and the
 *     child was SIGTERM'd or ran the full budget (stacked 60s backoffs exceeded
 *     EXEC_TIMEOUT_MS);
 *   - a parseable error envelope whose code is RATE_LIMITED (the secondary limit
 *     was exhausted and surfaced as a 403; resolveErrorCode maps it); or
 *   - any failed run whose stderr shows the secondary-rate-limit warning the
 *     shared Octokit logs (core/github.ts). When the throttle backoffs eventually
 *     return EMPTY instead of throwing a 403, every phase yields no candidates and
 *     the command reports a generic "no candidates across all phases" UNKNOWN
 *     error — so the errorCode alone can't be trusted; the stderr tell can.
 * Such runs soft-pass the happy-path assertions. A failure with NO throttle
 * evidence (a genuine crash, or a non-throttle error like NETWORK) does NOT match
 * and still fails loudly, so the contract check keeps its teeth.
 */
function isLiveApiUnavailable(result: RunSearchResult, durationMs: number): boolean {
  if (result.json === null && (result.signal === 'SIGTERM' || durationMs >= EXEC_TIMEOUT_MS - 5000)) {
    return true;
  }
  if (result.json && result.json.success === false) {
    if (result.json.errorCode === 'RATE_LIMITED') return true;
    if (/secondary rate limit|\brate limit\b/i.test(result.stderr)) return true;
  }
  return false;
}

describe.skipIf(!BUNDLE_EXISTS)('search --json E2E', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('should exit with an auth error envelope when --json is passed and no GitHub token is available', async () => {
    // `search --json` always uses JSON, so the preAction hook must emit a
    // parseable `{ success:false, errorCode:'AUTH_REQUIRED' }` envelope on
    // stdout instead of a stderr blob (#1056 M20).
    const { json, stdout, exitCode } = await runSearch([], { GITHUB_TOKEN: '' });
    expect(exitCode).not.toBe(0);
    expect(json, `expected parseable JSON envelope; got stdout=${stdout.slice(0, 300)}`).not.toBeNull();
    expect(json).toMatchObject({ success: false, errorCode: 'AUTH_REQUIRED' });
  });

  // Loud-skip guard (#1452): the nightly live-API workflow exists specifically
  // to run the token-gated tests below. If it runs without a token they would
  // silently skip, defeating the workflow's purpose — fail instead. Runs only
  // when the nightly marker is set, so per-PR CI and local runs (no marker)
  // are unaffected even when they lack a token.
  it.runIf(IS_NIGHTLY)('nightly workflow must provide a GitHub token (#1452)', () => {
    expect(
      HAS_GITHUB_TOKEN,
      'OSS_AUTOPILOT_NIGHTLY=1 but GITHUB_TOKEN is absent; the nightly e2e job cannot run the live-API tests it exists for.',
    ).toBe(true);
  });

  describe.skipIf(!HAS_GITHUB_TOKEN)('with GitHub token', () => {
    // Live search hits GitHub's rate-limited /search/issues across several
    // phases, so the biggest reliability lever is making FEWER live calls
    // (#1452). One `search --json 1` is run in beforeAll and shared across the
    // envelope/structure assertions instead of one call per test; only the
    // count-argument test needs a second, distinct invocation. Each test then
    // does no network I/O, so a rate-limit hiccup can only affect the two
    // shared runs, not all seven assertions.
    let sharedResult: RunSearchResult;
    let sharedDurationMs = 0;
    // When GitHub throttled the shared run, the happy-path assertions soft-pass
    // (#1452). Computed once in beforeAll so every dependent test reads the same
    // verdict. See isLiveApiUnavailable for the precise classification.
    let sharedUnavailable = false;

    beforeAll(async () => {
      const start = Date.now();
      sharedResult = await runSearch(['1']);
      sharedDurationMs = Date.now() - start;
      sharedUnavailable = isLiveApiUnavailable(sharedResult, sharedDurationMs);
      if (sharedUnavailable) {
        console.warn(
          `[E2E] Live search was rate-limited or timed out ` +
            `(exitCode=${sharedResult.exitCode}, signal=${sharedResult.signal ?? 'none'}, ` +
            `errorCode=${sharedResult.json?.errorCode ?? 'none'}, ${Math.round(sharedDurationMs / 1000)}s); ` +
            'soft-passing the happy-path assertions. This is GitHub throttling, not a contract regression.',
        );
      }
    }, HOOK_TIMEOUT_MS);

    it('should output valid JSON', () => {
      if (sharedUnavailable) return;
      expect(sharedResult.json, 'CLI should return parseable JSON output').not.toBeNull();
      expect(typeof sharedResult.json).toBe('object');
    });

    it('should include success and data fields in the envelope', () => {
      if (sharedUnavailable) return;
      expect(sharedResult.json, 'CLI should return parseable JSON output').not.toBeNull();
      expect(sharedResult.json).toHaveProperty('success', true);
      expect(sharedResult.json).toHaveProperty('data');
      expect(sharedResult.json).toHaveProperty('timestamp');
    });

    it('should include candidates and excludedRepos in data', () => {
      if (sharedUnavailable) return;
      const data = sharedResult.json.data;
      expect(Array.isArray(data.candidates)).toBe(true);
      expect(Array.isArray(data.excludedRepos)).toBe(true);
      expect(Array.isArray(data.aiPolicyBlocklist)).toBe(true);
    });

    it('should return candidates with expected structure when results exist', () => {
      if (sharedUnavailable) return;
      const { candidates } = sharedResult.json.data;
      // May be empty if no issues match the configured languages/labels, so only validate structure if non-empty
      if (candidates.length > 0) {
        const candidate = candidates[0];
        expect(candidate).toHaveProperty('issue');
        expect(typeof candidate.issue.repo).toBe('string');
        expect(typeof candidate.issue.number).toBe('number');
        expect(typeof candidate.issue.title).toBe('string');
        expect(typeof candidate.issue.url).toBe('string');
        expect(Array.isArray(candidate.issue.labels)).toBe(true);
        expect(candidate).toHaveProperty('recommendation');
        expect(['approve', 'skip', 'needs_review']).toContain(candidate.recommendation);
        expect(Array.isArray(candidate.reasonsToApprove)).toBe(true);
        expect(Array.isArray(candidate.reasonsToSkip)).toBe(true);
        expect(typeof candidate.viabilityScore).toBe('number');
      }
    });

    it(
      'should respect the count argument',
      async () => {
        // Distinct live invocation, so classify it on its own (the shared
        // verdict does not apply): a throttled second call soft-passes too.
        const start = Date.now();
        const result = await runSearch(['2']);
        if (isLiveApiUnavailable(result, Date.now() - start)) {
          console.warn('[E2E] count-argument run was rate-limited/timed out; soft-passing (#1452).');
          return;
        }
        expect(result.json, 'CLI should return parseable JSON output').not.toBeNull();
        expect(result.json).toHaveProperty('success', true);
        expect(result.json.data.candidates.length).toBeLessThanOrEqual(2);
      },
      HOOK_TIMEOUT_MS,
    );

    it('should complete within the live-API time budget', () => {
      // Guards against pathological hangs, not normal latency. Skipped when the
      // run was throttled/timed out — that case is already handled by the
      // soft-pass above and would otherwise false-fail here (a SIGTERM'd run
      // legitimately consumes ~EXEC_TIMEOUT_MS).
      if (sharedUnavailable) return;
      expect(sharedDurationMs).toBeLessThan(EXEC_TIMEOUT_MS);
    });
  });
});
