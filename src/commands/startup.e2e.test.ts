/**
 * E2E smoke tests for the startup --json command.
 * Runs the bundled CLI binary and validates JSON output.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const BUNDLE_PATH = path.resolve(__dirname, '../../dist/cli.bundle.cjs');
const TEST_HOME = '/tmp/oss-autopilot-e2e-test-' + process.pid;

async function runStartup(
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; json: any }> {
  let exitCode: number | null = 0;
  let signal: string | null = null;

  const result = await execFileAsync('node', [BUNDLE_PATH, 'startup', '--json'], {
    timeout: 5000,
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
      `stdout: ${result.stdout.slice(0, 500) || '(empty)'}\nstderr: ${result.stderr.slice(0, 500) || '(empty)'}`
    );
    json = null;
  }

  return { stdout: result.stdout, stderr: result.stderr, json };
}

describe('startup --json E2E', () => {
  beforeAll(() => {
    if (!fs.existsSync(BUNDLE_PATH)) {
      throw new Error(
        `Bundle not found at ${BUNDLE_PATH}. Run "npm run bundle" first.`,
      );
    }
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

  it('should complete within 5 seconds', async () => {
    const start = Date.now();
    await runStartup({ GITHUB_TOKEN: '' });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(5000);
  });
});
