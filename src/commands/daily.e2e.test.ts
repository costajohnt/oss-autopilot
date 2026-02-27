/**
 * E2E smoke tests for the daily --json command.
 * Runs the bundled CLI binary and validates JSON output.
 *
 * The daily command requires GitHub authentication. Tests validate:
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
const TEST_HOME = '/tmp/oss-autopilot-e2e-daily-test-' + process.pid;

/**
 * Check whether a real GitHub token is available for authenticated tests.
 * Uses GITHUB_TOKEN env var only (gh CLI may not be available in CI).
 */
const HAS_GITHUB_TOKEN = !!process.env.GITHUB_TOKEN;

async function runDaily(
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; json: any; exitCode: number | null }> {
  let exitCode: number | null = 0;
  let signal: string | null = null;

  const result = await execFileAsync('node', [BUNDLE_PATH, 'daily', '--json'], {
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

describe.skipIf(!BUNDLE_EXISTS)('daily --json E2E', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('should exit with an auth error when no GitHub token is available', async () => {
    const { stderr, exitCode } = await runDaily({ GITHUB_TOKEN: '', PATH: process.env.PATH || '' });
    // The preAction hook writes to stderr and calls process.exit(1)
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('GitHub authentication required');
  });

  describe.skipIf(!HAS_GITHUB_TOKEN)('with GitHub token', () => {
    it('should output valid JSON', async () => {
      const { json } = await runDaily();
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      expect(typeof json).toBe('object');
    });

    it('should include success and data fields in the envelope', async () => {
      const { json } = await runDaily();
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      expect(json).toHaveProperty('success', true);
      expect(json).toHaveProperty('data');
      expect(json).toHaveProperty('timestamp');
    });

    it('should include digest, capacity, and summary in data', async () => {
      const { json } = await runDaily();
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      const data = json.data;
      expect(data).toHaveProperty('digest');
      expect(data).toHaveProperty('capacity');
      expect(data).toHaveProperty('summary');
      expect(data).toHaveProperty('briefSummary');
      expect(data).toHaveProperty('actionableIssues');
      expect(data).toHaveProperty('actionMenu');
      expect(data).toHaveProperty('repoGroups');
      expect(data).toHaveProperty('failures');
    });

    it('should return capacity with expected fields', async () => {
      const { json } = await runDaily();
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      const { capacity } = json.data;
      expect(typeof capacity.hasCapacity).toBe('boolean');
      expect(typeof capacity.activePRCount).toBe('number');
      expect(typeof capacity.maxActivePRs).toBe('number');
      expect(typeof capacity.shelvedPRCount).toBe('number');
      expect(typeof capacity.criticalIssueCount).toBe('number');
      expect(typeof capacity.reason).toBe('string');
    });

    it('should return digest with summary fields', async () => {
      const { json } = await runDaily();
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      const { digest } = json.data;
      expect(digest).toHaveProperty('summary');
      expect(typeof digest.summary.totalActivePRs).toBe('number');
      expect(typeof digest.summary.totalNeedingAttention).toBe('number');
      expect(typeof digest.summary.totalMergedAllTime).toBe('number');
      expect(typeof digest.summary.mergeRate).toBe('number');
    });

    it('should return actionMenu with items and context', async () => {
      const { json } = await runDaily();
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      const { actionMenu } = json.data;
      expect(Array.isArray(actionMenu.items)).toBe(true);
      expect(actionMenu).toHaveProperty('context');
      expect(typeof actionMenu.context.hasActionableIssues).toBe('boolean');
      expect(typeof actionMenu.context.actionableCount).toBe('number');
      expect(typeof actionMenu.context.hasCapacity).toBe('boolean');
    });

    it('should return arrays for actionableIssues, repoGroups, and failures', async () => {
      const { json } = await runDaily();
      expect(json, 'CLI should return parseable JSON output').not.toBeNull();
      expect(Array.isArray(json.data.actionableIssues)).toBe(true);
      expect(Array.isArray(json.data.repoGroups)).toBe(true);
      expect(Array.isArray(json.data.failures)).toBe(true);
    });

    it('should complete within 30 seconds', async () => {
      const start = Date.now();
      await runDaily();
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(30000);
    });
  });
});
