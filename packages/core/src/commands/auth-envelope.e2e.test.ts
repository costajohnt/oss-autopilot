/**
 * E2E contract test for CLI auth-failure envelope (#1056 M20).
 *
 * When a non-local command (e.g. `daily`) runs without a GitHub token and
 * `--json` is passed, the CLI MUST emit a `{ success: false, errorCode: 'AUTH_REQUIRED' }`
 * JSON envelope to stdout — NOT a stderr blob followed by a non-zero exit
 * with no parseable output. Machine consumers (plugins, MCP stdio harnesses)
 * rely on this contract.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const BUNDLE_PATH = path.resolve(__dirname, '../../dist/cli.bundle.cjs');
const BUNDLE_EXISTS = fs.existsSync(BUNDLE_PATH);
const TEST_HOME = '/tmp/oss-autopilot-e2e-auth-envelope-' + process.pid;

// Dedicated PATH that can't resolve `gh` but can still run `node` — we write a
// symlink into a scratch dir below and point PATH at that dir.
const GH_LESS_PATH_DIR = path.join('/tmp', 'oss-autopilot-e2e-auth-envelope-path-' + process.pid);

async function runCliNoToken(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  let exitCode: number | null = 0;
  // Use the running process's absolute node binary so `execFile` doesn't rely
  // on the child's PATH to locate node. That way we can force PATH to a dir
  // that omits `gh` without also breaking node resolution.
  const result = await execFileAsync(process.execPath, [BUNDLE_PATH, ...args], {
    timeout: 5000,
    env: {
      ...process.env,
      GITHUB_TOKEN: '',
      PATH: GH_LESS_PATH_DIR,
      HOME: TEST_HOME,
    },
    cwd: TEST_HOME,
  }).catch((err: Error & { code?: number; stdout?: string; stderr?: string }) => {
    exitCode = err.code ?? null;
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode };
}

describe.skipIf(!BUNDLE_EXISTS)('CLI auth-failure envelope (--json)', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
    // Make a dir containing only a dummy `gh` fallback won't find — no
    // binaries — so the CLI's `gh auth token` branch returns null.
    fs.mkdirSync(GH_LESS_PATH_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.rmSync(GH_LESS_PATH_DIR, { recursive: true, force: true });
  });

  it('emits a parseable JSON envelope when --json is passed and auth is missing', async () => {
    // `daily` is not marked localOnly, so the preAction hook runs the token check.
    const { stdout, exitCode } = await runCliNoToken(['daily', '--json']);
    expect(exitCode, 'auth failure should exit non-zero').not.toBe(0);

    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(stdout);
    }).not.toThrow();

    expect(parsed).toMatchObject({
      success: false,
      errorCode: 'AUTH_REQUIRED',
    });
    // Human-readable `error` string is also required so consumers can surface it.
    expect((parsed as { error?: string }).error).toMatch(/github/i);
  });

  it('still writes the legacy human-readable stderr guide when --json is NOT passed', async () => {
    const { stderr, exitCode } = await runCliNoToken(['daily']);
    expect(exitCode).not.toBe(0);
    // The interactive path retains the multi-line guidance so `oss-autopilot daily`
    // still tells humans what to do.
    expect(stderr).toMatch(/GitHub authentication required/i);
    expect(stderr).toMatch(/gh auth login/);
  });
});
