/**
 * E2E smoke tests for the config --json command.
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
const TEST_HOME = '/tmp/oss-autopilot-e2e-config-test-' + process.pid;

async function runConfig(
  args: string[] = [],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; json: any }> {
  let exitCode: number | null = 0;
  let signal: string | null = null;

  const result = await execFileAsync('node', [BUNDLE_PATH, 'config', '--json', ...args], {
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

// ── #1431: localOnly commands bootstrap gist persistence best-effort ──────
//
// `config` is localOnly (no auth gate), but a gist-configured user's
// mutating localOnly commands must not silently write local-only. The CLI
// peeks the state file, warns on stderr when gist is configured but
// unreachable, and still completes the command (warn-and-proceed — these
// are the repair commands).
describe.skipIf(!BUNDLE_EXISTS)('localOnly gist bootstrap warning E2E (#1431)', () => {
  const GIST_HOME = '/tmp/oss-autopilot-e2e-gist-warn-test-' + process.pid;
  // PATH with only node's own directory: `gh` is deliberately unresolvable,
  // so the token probe fails deterministically with no network and no
  // dependence on the runner's gh auth state.
  const NODE_ONLY_PATH = path.dirname(process.execPath);

  beforeAll(() => {
    fs.mkdirSync(path.join(GIST_HOME, '.oss-autopilot'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(GIST_HOME, { recursive: true, force: true });
  });

  async function runConfigIn(home: string): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync(process.execPath, [BUNDLE_PATH, 'config', '--json'], {
      timeout: 10_000,
      env: { ...process.env, GITHUB_TOKEN: '', PATH: NODE_ONLY_PATH, HOME: home },
      cwd: home,
    }).catch((err: any) => ({ stdout: (err.stdout as string) || '', stderr: (err.stderr as string) || '' }));
    return { stdout: result.stdout, stderr: result.stderr };
  }

  it('warns LOCAL-ONLY on stderr and still succeeds when gist is configured but no token is available', async () => {
    fs.writeFileSync(
      path.join(GIST_HOME, '.oss-autopilot', 'state.json'),
      JSON.stringify({ version: 4, config: { persistence: 'gist' } }),
      'utf8',
    );

    const { stdout, stderr } = await runConfigIn(GIST_HOME);

    expect(stderr).toContain('LOCAL-ONLY');
    // The command itself still completes with a success envelope, and the
    // degradation also rides the envelope so --json consumers see it (#1433).
    const json = JSON.parse(stdout);
    expect(json).toHaveProperty('success', true);
    expect(json.gistInitWarning).toContain('LOCAL-ONLY');
  });

  it('emits no gist warning for a local-mode state file', async () => {
    fs.writeFileSync(
      path.join(GIST_HOME, '.oss-autopilot', 'state.json'),
      JSON.stringify({ version: 4, config: { persistence: 'local' } }),
      'utf8',
    );

    const { stdout, stderr } = await runConfigIn(GIST_HOME);

    expect(stderr).not.toContain('LOCAL-ONLY');
    const json = JSON.parse(stdout);
    expect(json).toHaveProperty('success', true);
    expect(json).not.toHaveProperty('gistInitWarning');
  });
});

describe.skipIf(!BUNDLE_EXISTS)('config --json E2E', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('should output valid JSON', async () => {
    const { json } = await runConfig([], { GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    expect(typeof json).toBe('object');
  });

  it('should include success and data fields in the envelope', async () => {
    const { json } = await runConfig([], { GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    expect(json).toHaveProperty('success', true);
    expect(json).toHaveProperty('data');
    expect(json).toHaveProperty('timestamp');
  });

  it('should include a config object in data', async () => {
    const { json } = await runConfig([], { GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    expect(json.data).toHaveProperty('config');
    expect(typeof json.data.config).toBe('object');
  });

  it('should return default config fields when no state file exists', async () => {
    const { json } = await runConfig([], { GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    const { config } = json.data;
    expect(Array.isArray(config.languages)).toBe(true);
    expect(Array.isArray(config.labels)).toBe(true);
    expect(Array.isArray(config.excludeRepos)).toBe(true);
    expect(Array.isArray(config.trustedProjects)).toBe(true);
    expect(typeof config.githubUsername).toBe('string');
  });

  it('should return an error when key is provided without value', async () => {
    // config command uses positional args: config [key] [value]
    // Passing a key but no value should produce a JSON error envelope
    const { json } = await runConfig(['username'], { GITHUB_TOKEN: '' });
    expect(json, 'CLI should return parseable JSON output').not.toBeNull();
    expect(json).toHaveProperty('success', false);
    expect(json).toHaveProperty('error');
    expect(typeof json.error).toBe('string');
  });

  it('should complete within 5 seconds', async () => {
    const start = Date.now();
    await runConfig([], { GITHUB_TOKEN: '' });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(5000);
  });
});
