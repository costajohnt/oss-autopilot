/**
 * E2E smoke tests for the daily --json command.
 * Runs the bundled CLI binary and validates JSON output.
 *
 * The daily command requires GitHub authentication. Tests validate:
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
const TEST_HOME = '/tmp/oss-autopilot-e2e-daily-test-' + process.pid;

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

/**
 * GitHub user the seeded `daily` run queries open PRs for. Hardcoded to the
 * repo owner (a stable, public account) rather than the token's own user so
 * the test is deterministic regardless of which token the nightly runner holds
 * — `daily` only needs SOME resolvable username to drive its PR fetch, and the
 * assertions validate the envelope shape, not which PRs come back.
 */
const SEED_USERNAME = 'costajohnt';

// The token-gated `daily` run does live GitHub I/O (multi-phase fetch); 30s is
// too tight once a transient backoff is in play. 120s gives a single retry
// room without failing the test (#1452).
const EXEC_TIMEOUT_MS = 120_000;

/**
 * Seed a githubUsername into the test HOME so `daily --json` reaches its
 * success path instead of returning the CONFIGURATION error envelope. Runs the
 * bundle's `init <username>` against the same HOME the daily run uses.
 */
async function seedUsername(): Promise<void> {
  await execFileAsync('node', [BUNDLE_PATH, 'init', SEED_USERNAME, '--json'], {
    timeout: EXEC_TIMEOUT_MS,
    env: { ...process.env, HOME: TEST_HOME },
    cwd: TEST_HOME,
  });
}

async function runDaily(
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; json: any; exitCode: number | null }> {
  let exitCode: number | null = 0;
  let signal: string | null = null;

  const result = await execFileAsync('node', [BUNDLE_PATH, 'daily', '--json'], {
    timeout: EXEC_TIMEOUT_MS,
    env: { ...process.env, ...env, HOME: TEST_HOME },
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

describe.skipIf(!BUNDLE_EXISTS)('daily --json E2E', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('should exit with an auth error envelope when --json is passed and no GitHub token is available', async () => {
    // `daily --json` always uses JSON, so the preAction hook must emit a
    // parseable `{ success:false, errorCode:'AUTH_REQUIRED' }` envelope on
    // stdout instead of a stderr blob (#1056 M20).
    const { json, stdout, exitCode } = await runDaily({ GITHUB_TOKEN: '' });
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
    // One live `daily` run shared across the structural assertions below
    // (#1452): daily does heavy multi-phase GitHub I/O, so calling it per-test
    // (eight times) was both slow and pointlessly chatty. The username seed
    // makes the run reach its success path instead of the CONFIGURATION error
    // envelope a fresh HOME would otherwise produce.
    let sharedJson: any;
    let sharedDurationMs = 0;

    beforeAll(async () => {
      await seedUsername();
      const start = Date.now();
      const { json } = await runDaily();
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

    it('should include digest, capacity, and summary in data', () => {
      expect(sharedJson, 'CLI should return parseable JSON output').not.toBeNull();
      const data = sharedJson.data;
      expect(data).toHaveProperty('digest');
      expect(data).toHaveProperty('capacity');
      expect(data).toHaveProperty('summary');
      expect(data).toHaveProperty('briefSummary');
      expect(data).toHaveProperty('actionableIssues');
      expect(data).toHaveProperty('actionMenu');
      expect(data).toHaveProperty('repoGroups');
      expect(data).toHaveProperty('failures');
    });

    it('should return capacity with expected fields', () => {
      expect(sharedJson, 'CLI should return parseable JSON output').not.toBeNull();
      const { capacity } = sharedJson.data;
      expect(typeof capacity.hasCapacity).toBe('boolean');
      expect(typeof capacity.activePRCount).toBe('number');
      expect(typeof capacity.maxActivePRs).toBe('number');
      expect(typeof capacity.shelvedPRCount).toBe('number');
      expect(typeof capacity.criticalIssueCount).toBe('number');
      expect(typeof capacity.reason).toBe('string');
    });

    it('should return digest with summary fields', () => {
      expect(sharedJson, 'CLI should return parseable JSON output').not.toBeNull();
      const { digest } = sharedJson.data;
      expect(digest).toHaveProperty('summary');
      expect(typeof digest.summary.totalActivePRs).toBe('number');
      expect(typeof digest.summary.totalNeedingAttention).toBe('number');
      expect(typeof digest.summary.totalMergedAllTime).toBe('number');
      expect(typeof digest.summary.mergeRate).toBe('number');
    });

    it('should return actionMenu with items and context', () => {
      expect(sharedJson, 'CLI should return parseable JSON output').not.toBeNull();
      const { actionMenu } = sharedJson.data;
      expect(Array.isArray(actionMenu.items)).toBe(true);
      expect(actionMenu).toHaveProperty('context');
      expect(typeof actionMenu.context.hasActionableIssues).toBe('boolean');
      expect(typeof actionMenu.context.actionableCount).toBe('number');
      expect(typeof actionMenu.context.hasCapacity).toBe('boolean');
    });

    it('should return arrays for actionableIssues, repoGroups, and failures', () => {
      expect(sharedJson, 'CLI should return parseable JSON output').not.toBeNull();
      expect(Array.isArray(sharedJson.data.actionableIssues)).toBe(true);
      expect(Array.isArray(sharedJson.data.repoGroups)).toBe(true);
      expect(Array.isArray(sharedJson.data.failures)).toBe(true);
    });

    it('should complete within the live-API time budget', () => {
      // Ceiling raised from the old 30s to the live-API budget (#1452): a real
      // multi-phase daily fetch with a transient backoff legitimately exceeds
      // 30s. This guards against pathological hangs, not normal latency.
      expect(sharedDurationMs).toBeLessThan(EXEC_TIMEOUT_MS);
    });
  });
});
