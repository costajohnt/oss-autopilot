/**
 * Tests for the doctor command (#1039).
 *
 * Each check is covered with an ok-path + at least one warning/error path.
 * External side effects (child_process, fs, Octokit, token resolution) are
 * mocked at module level so every path is deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Module-level mocks ──────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getGitHubTokenAsync: vi.fn(),
    getOctokit: vi.fn(),
    getStatePath: vi.fn(),
  };
});

import { execFile } from 'child_process';
import { getGitHubTokenAsync, getOctokit, getStatePath } from '../core/index.js';
import {
  checkBundleUpToDate,
  checkGhAuth,
  checkGhCli,
  checkGitHubRateLimit,
  checkGitHubToken,
  checkScoutResolvable,
  checkStateFile,
  runDoctor,
} from './doctor.js';

const mockExecFile = vi.mocked(execFile);
const mockGetGitHubTokenAsync = vi.mocked(getGitHubTokenAsync);
const mockGetOctokit = vi.mocked(getOctokit);
const mockGetStatePath = vi.mocked(getStatePath);

/**
 * Configure `mockExecFile` to return distinct (stdout/err/code) results per
 * invocation. Each entry represents one `execFile(...)` call in order.
 *
 * Shape note: `util.promisify(execFile)` resolves to the **first non-error
 * argument** passed to the callback — so we invoke the callback with a
 * single `{stdout, stderr}` object, matching what the real Node child
 * process helper yields when promisified.
 */
function stubExecFile(responses: Array<{ stdout?: string; stderr?: string; error?: Error & { code?: number } }>): void {
  let i = 0;
  mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: Error | null, value?: { stdout: string; stderr: string }) => void;
    const r = responses[i++] ?? responses[responses.length - 1];
    if (r.error) {
      callback(r.error);
    } else {
      callback(null, { stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
    }
    return {} as unknown as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── checkGhCli ──────────────────────────────────────────────────────────

describe('checkGhCli', () => {
  it('reports ok when `gh --version` succeeds', async () => {
    stubExecFile([{ stdout: 'gh version 2.50.0 (2024-06-01)\nhttps://github.com/cli/cli/releases/tag/v2.50.0\n' }]);
    const result = await checkGhCli();
    expect(result.status).toBe('ok');
    expect(result.message).toContain('gh version 2.50.0');
  });

  it('reports "not on PATH" when spawn fails with ENOENT', async () => {
    stubExecFile([{ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }]);
    const result = await checkGhCli();
    expect(result.status).toBe('warning');
    expect(result.message).toMatch(/not found on PATH/);
    expect(result.remediation).toMatch(/cli\.github\.com/);
  });

  it('distinguishes "present but broken" from "not installed"', async () => {
    // A timeout or non-ENOENT spawn error means gh *is* installed but isn't
    // usable — telling the user to install gh would be actively misleading.
    stubExecFile([{ error: Object.assign(new Error('command timed out'), { code: 'ETIMEDOUT' }) }]);
    const result = await checkGhCli();
    expect(result.status).toBe('warning');
    expect(result.message).toMatch(/present but failed to run/);
    expect(result.message).toMatch(/timed out/);
    expect(result.remediation).not.toMatch(/cli\.github\.com/);
  });
});

// ── checkGhAuth ─────────────────────────────────────────────────────────

describe('checkGhAuth', () => {
  it('reports ok when gh is authenticated', async () => {
    stubExecFile([{ stdout: 'Logged in to github.com as user (oauth_token)' }]);
    const result = await checkGhAuth();
    expect(result.status).toBe('ok');
  });

  it('reports warning when gh auth status fails, mentioning both auth and network as possible causes', async () => {
    stubExecFile([
      { error: Object.assign(new Error('not authenticated'), { code: 1 as never }), stderr: 'not logged in' },
    ]);
    const result = await checkGhAuth();
    expect(result.status).toBe('warning');
    // Remediation should cover both the "not logged in" case AND the network/proxy case.
    expect(result.remediation).toMatch(/gh auth login/);
    expect(result.remediation).toMatch(/network|proxy/i);
  });
});

// ── checkGitHubToken ────────────────────────────────────────────────────

describe('checkGitHubToken', () => {
  it('warns when no token is available', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const result = await checkGitHubToken();
    expect(result.status).toBe('warning');
    expect(result.remediation).toMatch(/GITHUB_TOKEN|gh auth login/);
  });

  it('reports ok when token authenticates successfully', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_abc123');
    const mockOctokit = {
      users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'octocat' } }) },
    };
    mockGetOctokit.mockReturnValue(mockOctokit as any);
    const result = await checkGitHubToken();
    expect(result.status).toBe('ok');
    expect(result.message).toContain('@octocat');
  });

  it('reports error when token is present but API auth fails', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_expired');
    const mockOctokit = {
      users: { getAuthenticated: vi.fn().mockRejectedValue(new Error('Bad credentials')) },
    };
    mockGetOctokit.mockReturnValue(mockOctokit as any);
    const result = await checkGitHubToken();
    expect(result.status).toBe('error');
    expect(result.message).toContain('Bad credentials');
    expect(result.remediation).toMatch(/refresh|fresh/);
  });
});

// ── checkBundleUpToDate ─────────────────────────────────────────────────

describe('checkBundleUpToDate', () => {
  const tmpBase = path.join(os.tmpdir(), `oss-autopilot-doctor-${process.pid}`);

  beforeEach(() => {
    fs.mkdirSync(tmpBase, { recursive: true });
  });

  it('reports ok when bundle is newer than source', () => {
    const bundlePath = path.join(tmpBase, 'fresh-bundle.cjs');
    const sourcePath = path.join(tmpBase, 'fresh-source.ts');
    fs.writeFileSync(sourcePath, '// src');
    fs.writeFileSync(bundlePath, '// bundle');
    // Bump bundle mtime forward so it's strictly newer than source.
    const newer = new Date(Date.now() + 10_000);
    fs.utimesSync(bundlePath, newer, newer);

    const result = checkBundleUpToDate({ bundlePath, sourcePath });
    expect(result.status).toBe('ok');
  });

  it('reports warning when source is newer than bundle', () => {
    const bundlePath = path.join(tmpBase, 'stale-bundle.cjs');
    const sourcePath = path.join(tmpBase, 'stale-source.ts');
    fs.writeFileSync(bundlePath, '// bundle');
    fs.writeFileSync(sourcePath, '// src');
    const newer = new Date(Date.now() + 10_000);
    fs.utimesSync(sourcePath, newer, newer);

    const result = checkBundleUpToDate({ bundlePath, sourcePath });
    expect(result.status).toBe('warning');
    expect(result.remediation).toMatch(/pnpm run bundle/);
  });

  it('reports warning when bundle is missing but source exists', () => {
    const bundlePath = path.join(tmpBase, 'nope-bundle.cjs');
    const sourcePath = path.join(tmpBase, 'only-source.ts');
    fs.writeFileSync(sourcePath, '// src');
    const result = checkBundleUpToDate({ bundlePath, sourcePath });
    expect(result.status).toBe('warning');
    expect(result.message).toMatch(/not built yet/);
  });

  it('reports ok when bundle exists and source does not (npm install scenario)', () => {
    const bundlePath = path.join(tmpBase, 'installed-bundle.cjs');
    const sourcePath = path.join(tmpBase, 'never-shipped-source.ts');
    fs.writeFileSync(bundlePath, '// bundle');
    const result = checkBundleUpToDate({ bundlePath, sourcePath });
    expect(result.status).toBe('ok');
  });

  it('reports warning when neither bundle nor source exist', () => {
    const result = checkBundleUpToDate({
      bundlePath: path.join(tmpBase, 'absent-bundle'),
      sourcePath: path.join(tmpBase, 'absent-source'),
    });
    expect(result.status).toBe('warning');
  });
});

// ── checkStateFile ──────────────────────────────────────────────────────

describe('checkStateFile', () => {
  const tmpBase = path.join(os.tmpdir(), `oss-autopilot-doctor-state-${process.pid}`);

  beforeEach(() => {
    fs.mkdirSync(tmpBase, { recursive: true });
  });

  it('reports ok when state file does not exist', () => {
    const statePath = path.join(tmpBase, 'missing.json');
    mockGetStatePath.mockReturnValue(statePath);
    const result = checkStateFile();
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/first run/i);
  });

  it('reports ok when state file parses and validates', () => {
    const statePath = path.join(tmpBase, 'valid.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 4,
        repoScores: {},
        config: { githubUsername: 'u' },
        lastRunAt: new Date().toISOString(),
        activeIssues: [],
      }),
    );
    const result = checkStateFile({ statePathOverride: statePath });
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/v4/);
  });

  it('reports error when state file has invalid JSON', () => {
    const statePath = path.join(tmpBase, 'garbage.json');
    fs.writeFileSync(statePath, '{ this is not json');
    const result = checkStateFile({ statePathOverride: statePath });
    expect(result.status).toBe('error');
    expect(result.remediation).toMatch(/backup/i);
  });

  it('reports error when state file fails schema validation', () => {
    const statePath = path.join(tmpBase, 'badschema.json');
    fs.writeFileSync(statePath, JSON.stringify({ version: 99 /* unsupported */ }));
    const result = checkStateFile({ statePathOverride: statePath });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/schema validation/i);
  });
});

// ── checkScoutResolvable ────────────────────────────────────────────────

describe('checkScoutResolvable', () => {
  // @oss-scout/core is a real workspace dependency, so this check should pass
  // in the test environment. `import()` goes through Node's ESM resolver,
  // which honors the `exports` map that require.resolve cannot.
  it('reports ok when @oss-scout/core resolves', async () => {
    const result = await checkScoutResolvable();
    expect(result.status).toBe('ok');
  });

  it('reports error with reinstall remediation when the package is not found', async () => {
    const notFound = Object.assign(new Error("Cannot find package '@oss-scout/core'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const result = await checkScoutResolvable(() => Promise.reject(notFound));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/install issue/i);
    expect(result.remediation).toMatch(/reinstall/i);
  });

  it('reports error with reinstall remediation on a corrupt install (ERR_PACKAGE_PATH_NOT_EXPORTED)', async () => {
    const corrupt = Object.assign(new Error('No "exports" main defined'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
    const result = await checkScoutResolvable(() => Promise.reject(corrupt));
    expect(result.status).toBe('error');
    expect(result.remediation).toMatch(/reinstall/i);
  });

  it('reports error with bug-report remediation when the package throws during init', async () => {
    const initErr = new TypeError('Cannot read properties of undefined (reading ...)');
    const result = await checkScoutResolvable(() => Promise.reject(initErr));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/failed to load/i);
    expect(result.remediation).toMatch(/report this as a bug/i);
  });
});

// ── checkGitHubRateLimit ────────────────────────────────────────────────

describe('checkGitHubRateLimit', () => {
  it('warns when no token is available', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const result = await checkGitHubRateLimit();
    expect(result.status).toBe('warning');
  });

  it('reports ok when remaining requests are plentiful', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_ok');
    mockGetOctokit.mockReturnValue({
      rateLimit: {
        get: vi
          .fn()
          .mockResolvedValue({ data: { resources: { core: { remaining: 4500, limit: 5000, reset: 1_700_000_000 } } } }),
      },
    } as any);
    const result = await checkGitHubRateLimit();
    expect(result.status).toBe('ok');
    expect(result.message).toContain('4500/5000');
  });

  it('warns when remaining requests are below 100', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_low');
    mockGetOctokit.mockReturnValue({
      rateLimit: {
        get: vi
          .fn()
          .mockResolvedValue({ data: { resources: { core: { remaining: 42, limit: 5000, reset: 1_700_000_000 } } } }),
      },
    } as any);
    const result = await checkGitHubRateLimit();
    expect(result.status).toBe('warning');
    expect(result.message).toContain('42/5000');
  });

  it('reports error when rate-limit API fails', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_dead');
    mockGetOctokit.mockReturnValue({
      rateLimit: { get: vi.fn().mockRejectedValue(new Error('network down')) },
    } as any);
    const result = await checkGitHubRateLimit();
    expect(result.status).toBe('error');
    expect(result.message).toContain('network down');
  });
});

// ── runDoctor orchestrator ──────────────────────────────────────────────

describe('runDoctor', () => {
  it('returns a summary reflecting every check status', async () => {
    // Token check fails quickly (no token) → warnings drive summary.
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    mockGetStatePath.mockReturnValue(path.join(os.tmpdir(), 'oss-autopilot-doctor-nofile.json'));
    stubExecFile([{ error: Object.assign(new Error('no gh'), { code: 'ENOENT' as never }) }]);

    const result = await runDoctor();
    expect(result.checks.length).toBeGreaterThanOrEqual(6);
    expect(result.summary.ok + result.summary.warnings + result.summary.errors).toBe(result.checks.length);
  });

  it('never aborts — a crashing check is converted to a synthetic error entry', async () => {
    // Doctor is the tool users run when things are already broken. A single
    // crashing check must not swallow the whole report.
    mockGetGitHubTokenAsync.mockImplementation(() => {
      throw new Error('unexpected sync crash from token fetch');
    });
    mockGetStatePath.mockReturnValue(path.join(os.tmpdir(), 'oss-autopilot-doctor-nofile.json'));
    stubExecFile([{ error: Object.assign(new Error('no gh'), { code: 'ENOENT' as never }) }]);

    // Should resolve, not reject, even with the synchronous throw above.
    const result = await runDoctor();
    expect(result.checks.length).toBeGreaterThanOrEqual(6);
  });
});
