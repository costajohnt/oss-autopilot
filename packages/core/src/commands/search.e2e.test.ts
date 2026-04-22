/**
 * E2E smoke tests for the search --json command.
 * Runs the bundled CLI binary and validates JSON output.
 *
 * The search command requires GitHub authentication. Tests validate:
 * - Auth error behavior when no token is available (always runs)
 * - Full JSON envelope and data structure when a token IS available
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const BUNDLE_PATH = path.resolve(__dirname, '../../dist/cli.bundle.cjs');
const BUNDLE_EXISTS = fs.existsSync(BUNDLE_PATH);
const TEST_HOME = '/tmp/oss-autopilot-e2e-search-test-' + process.pid;

/**
 * Check whether a real GitHub token is available for authenticated tests.
 * Uses GITHUB_TOKEN env var only (gh CLI may not be available in CI).
 */
const HAS_GITHUB_TOKEN = !!process.env.GITHUB_TOKEN;

async function runSearch(
  args: string[] = [],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; json: any; exitCode: number | null }> {
  let exitCode: number | null = 0;
  let signal: string | null = null;

  const result = await execFileAsync('node', [BUNDLE_PATH, 'search', '--json', ...args], {
    timeout: 30000,
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

  describe.skipIf(!HAS_GITHUB_TOKEN)('with GitHub token', () => {
    it('should output valid JSON', async () => {
      const { json } = await runSearch(['1']);
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      expect(typeof json).toBe('object');
    });

    it('should include success and data fields in the envelope', async () => {
      const { json } = await runSearch(['1']);
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      expect(json).toHaveProperty('success', true);
      expect(json).toHaveProperty('data');
      expect(json).toHaveProperty('timestamp');
    });

    it('should include candidates and excludedRepos in data', async () => {
      const { json } = await runSearch(['1']);
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      const data = json.data;
      expect(Array.isArray(data.candidates)).toBe(true);
      expect(Array.isArray(data.excludedRepos)).toBe(true);
      expect(Array.isArray(data.aiPolicyBlocklist)).toBe(true);
    });

    it('should return candidates with expected structure when results exist', async () => {
      const { json } = await runSearch(['1']);
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      const { candidates } = json.data;
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

    it('should respect the count argument', async () => {
      const { json } = await runSearch(['2']);
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      expect(json.data.candidates.length).toBeLessThanOrEqual(2);
    });

    it('should complete within 30 seconds', async () => {
      const start = Date.now();
      await runSearch(['1']);
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(30000);
    });
  });
});
