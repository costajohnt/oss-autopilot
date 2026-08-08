/**
 * E2E smoke tests for the startup --json command.
 * Runs the bundled CLI binary and validates JSON output.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

const BUNDLE_PATH = path.resolve(__dirname, '../../dist/cli.bundle.cjs');
const BUNDLE_EXISTS = fs.existsSync(BUNDLE_PATH);
const TEST_HOME = '/tmp/oss-autopilot-e2e-test-' + process.pid;

/** Budget for the CLI subprocess itself. Exceeding it is a real failure. */
const STARTUP_BUDGET_MS = 5000;

/**
 * Vitest timeout for each test. Must stay comfortably above STARTUP_BUDGET_MS:
 * if the two are equal, vitest aborts the test before the subprocess timeout
 * fires, so a slow runner reports a bare "test timed out" instead of the
 * diagnostics runStartup collects.
 */
const TEST_TIMEOUT_MS = 15_000;

async function runStartup(env?: Record<string, string>): Promise<{ stdout: string; stderr: string; json: any }> {
  let exitCode: number | null = 0;
  let signal: string | null = null;

  const result = await execFileAsync('node', [BUNDLE_PATH, 'startup', '--json'], {
    timeout: STARTUP_BUDGET_MS,
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

  return { stdout: result.stdout, stderr: result.stderr, json };
}

describe.skipIf(!BUNDLE_EXISTS)('startup --json E2E', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('should output valid JSON', async () => {
    const { json } = await runStartup({ GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    expect(typeof json).toBe('object');
  });

  it('should include success and data fields in the envelope', async () => {
    const { json } = await runStartup({ GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    expect(json).toHaveProperty('success', true);
    expect(json).toHaveProperty('data');
    expect(json).toHaveProperty('timestamp');
  });

  it('should include version and setupComplete in data', async () => {
    const { json } = await runStartup({ GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    const data = json.data;
    expect(data).toHaveProperty('version');
    expect(typeof data.version).toBe('string');
    expect(data).toHaveProperty('setupComplete');
    expect(typeof data.setupComplete).toBe('boolean');
  });

  it('should return setupComplete: false when no state file exists', async () => {
    const { json } = await runStartup({ GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    expect(json.data.setupComplete).toBe(false);
  });

  it('should complete within the startup budget', async () => {
    const start = Date.now();
    await runStartup({ GITHUB_TOKEN: '' });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(STARTUP_BUDGET_MS);
  });
});
