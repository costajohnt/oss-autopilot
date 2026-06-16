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
// (see scout-bridge buildScoutState). That makes one run take ~100s. For the
// e2e/nightly run we collapse the delays via these env vars (read by
// commands/search.ts, #1452) AND raise the per-exec timeout to 120s so a single
// secondary-limit backoff still has room to retry instead of failing the test.
const EXEC_TIMEOUT_MS = 120_000;
const SCOUT_DELAY_ENV = {
  OSS_AUTOPILOT_SCOUT_INTER_PHASE_DELAY_MS: '0',
  OSS_AUTOPILOT_SCOUT_BROAD_PHASE_DELAY_MS: '0',
};

async function runSearch(
  args: string[] = [],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; json: any; exitCode: number | null }> {
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

  return { stdout: result.stdout, stderr: result.stderr, json, exitCode };
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
    let sharedJson: any;
    let sharedDurationMs = 0;

    beforeAll(async () => {
      const start = Date.now();
      const { json } = await runSearch(['1']);
      sharedDurationMs = Date.now() - start;
      sharedJson = json;
    }, EXEC_TIMEOUT_MS);

    it('should output valid JSON', () => {
      expect(sharedJson, 'CLI should return parseable JSON output').not.toBeNull();
      expect(typeof sharedJson).toBe('object');
    });

    it('should include success and data fields in the envelope', () => {
      expect(sharedJson, 'CLI should return parseable JSON output').not.toBeNull();
      expect(sharedJson).toHaveProperty('success', true);
      expect(sharedJson).toHaveProperty('data');
      expect(sharedJson).toHaveProperty('timestamp');
    });

    it('should include candidates and excludedRepos in data', () => {
      expect(sharedJson, 'CLI should return parseable JSON output').not.toBeNull();
      const data = sharedJson.data;
      expect(Array.isArray(data.candidates)).toBe(true);
      expect(Array.isArray(data.excludedRepos)).toBe(true);
      expect(Array.isArray(data.aiPolicyBlocklist)).toBe(true);
    });

    it('should return candidates with expected structure when results exist', () => {
      expect(sharedJson, 'CLI should return parseable JSON output').not.toBeNull();
      const { candidates } = sharedJson.data;
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
        const { json } = await runSearch(['2']);
        expect(json, 'CLI should return parseable JSON output').not.toBeNull();
        expect(json.data.candidates.length).toBeLessThanOrEqual(2);
      },
      EXEC_TIMEOUT_MS,
    );

    it('should complete within the live-API time budget', () => {
      // Ceiling raised from the old 30s to the live-API budget (#1452): even
      // with the inter-phase delays collapsed to 0, a live multi-phase search
      // plus a possible secondary-rate-limit backoff legitimately exceeds 30s.
      // This guards against pathological hangs, not normal latency.
      expect(sharedDurationMs).toBeLessThan(EXEC_TIMEOUT_MS);
    });
  });
});
