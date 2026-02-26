/**
 * E2E smoke tests for the status --json command.
 * Runs the bundled CLI binary and validates JSON output.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const BUNDLE_PATH = path.resolve(__dirname, '../../dist/cli.bundle.cjs');
const BUNDLE_EXISTS = fs.existsSync(BUNDLE_PATH);
const TEST_HOME = '/tmp/oss-autopilot-e2e-status-test-' + process.pid;

async function runStatus(env?: Record<string, string>): Promise<{ stdout: string; stderr: string; json: any }> {
  let exitCode: number | null = 0;
  let signal: string | null = null;

  const result = await execFileAsync('node', [BUNDLE_PATH, 'status', '--json'], {
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
        `stdout: ${result.stdout.slice(0, 500) || '(empty)'}\nstderr: ${result.stderr.slice(0, 500) || '(empty)'}`,
    );
    json = null;
  }

  return { stdout: result.stdout, stderr: result.stderr, json };
}

describe.skipIf(!BUNDLE_EXISTS)('status --json E2E', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('should output valid JSON', async () => {
    const { json } = await runStatus({ GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    expect(typeof json).toBe('object');
  });

  it('should include success and data fields in the envelope', async () => {
    const { json } = await runStatus({ GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    expect(json).toHaveProperty('success', true);
    expect(json).toHaveProperty('data');
    expect(json).toHaveProperty('timestamp');
  });

  it('should include stats, activePRs, dormantPRs, and lastRunAt in data', async () => {
    const { json } = await runStatus({ GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    const data = json.data;
    expect(data).toHaveProperty('stats');
    expect(data).toHaveProperty('activePRs');
    expect(data).toHaveProperty('dormantPRs');
    expect(data).toHaveProperty('lastRunAt');
  });

  it('should return empty PR arrays when no state file exists', async () => {
    const { json } = await runStatus({ GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    expect(Array.isArray(json.data.activePRs)).toBe(true);
    expect(json.data.activePRs).toHaveLength(0);
    expect(Array.isArray(json.data.dormantPRs)).toBe(true);
    expect(json.data.dormantPRs).toHaveLength(0);
  });

  it('should return stats with expected numeric fields', async () => {
    const { json } = await runStatus({ GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    const { stats } = json.data;
    expect(typeof stats.activePRs).toBe('number');
    expect(typeof stats.dormantPRs).toBe('number');
    expect(typeof stats.mergedPRs).toBe('number');
    expect(typeof stats.closedPRs).toBe('number');
    expect(typeof stats.activeIssues).toBe('number');
    expect(typeof stats.trustedProjects).toBe('number');
    expect(typeof stats.needsResponse).toBe('number');
    expect(typeof stats.mergeRate).toBe('string');
  });

  it('should complete within 5 seconds', async () => {
    const start = Date.now();
    await runStatus({ GITHUB_TOKEN: '' });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(5000);
  });
});
