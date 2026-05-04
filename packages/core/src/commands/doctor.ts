/**
 * Doctor command — a real system-health audit.
 *
 * Runs independent checks against the local environment and reports an
 * aggregate `DoctorOutput` so users can diagnose common failure modes
 * (missing token, unauthenticated gh CLI, stale bundle, corrupted state,
 * unresolvable scout dependency, low rate-limit budget) in one go.
 *
 * Each `check*` function is exported individually so tests can mock its
 * external dependencies in isolation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getGitHubTokenAsync, getOctokit, getStatePath } from '../core/index.js';
import { AgentStateSchema } from '../core/state-schema.js';
import { errorMessage } from '../core/errors.js';

const execFileAsync = promisify(execFile);

export type DoctorCheckStatus = 'ok' | 'warning' | 'error';

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorOutput {
  checks: DoctorCheck[];
  summary: { ok: number; warnings: number; errors: number };
}

const GH_CMD_TIMEOUT_MS = 3000;

// ── Individual checks ───────────────────────────────────────────────────

/** Extract a Node errno-style code from an unknown thrown value. */
function errCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export async function checkGhCli(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync('gh', ['--version'], { timeout: GH_CMD_TIMEOUT_MS });
    const versionLine = stdout.split('\n')[0]?.trim() || 'gh present';
    return { name: 'gh CLI installed', status: 'ok', message: versionLine };
  } catch (err) {
    // Distinguish "not on PATH" (ENOENT) from "present but broken" (anything
    // else — spawn errors, timeouts, permission denied, non-zero exit). Telling
    // users to "install gh" when gh is already installed is actively misleading.
    const code = errCode(err);
    if (code === 'ENOENT') {
      return {
        name: 'gh CLI installed',
        status: 'warning',
        message: 'gh CLI not found on PATH',
        remediation: 'Install the GitHub CLI from https://cli.github.com/',
      };
    }
    return {
      name: 'gh CLI installed',
      status: 'warning',
      message: `gh CLI present but failed to run: ${errorMessage(err)}`,
      remediation:
        'Check that `gh --version` works in your shell; a timeout or permission error may indicate a broken install',
    };
  }
}

export async function checkGhAuth(): Promise<DoctorCheck> {
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: GH_CMD_TIMEOUT_MS });
    return { name: 'gh CLI authenticated', status: 'ok', message: 'Signed in to github.com' };
  } catch (err) {
    // `gh auth status` also exits non-zero on network/proxy failures and TLS
    // issues reaching github.com — not only when the user isn't logged in.
    // Mentioning both paths in the remediation avoids misleading users whose
    // problem is connectivity, not auth.
    return {
      name: 'gh CLI authenticated',
      status: 'warning',
      message: `gh auth status failed: ${errorMessage(err)}`,
      remediation:
        'Run `gh auth login` to authenticate, or check network/proxy connectivity if the error looks network-related',
    };
  }
}

export async function checkGitHubToken(preloadedToken?: string | null): Promise<DoctorCheck> {
  const token = preloadedToken !== undefined ? preloadedToken : await getGitHubTokenAsync();
  if (!token) {
    return {
      name: 'GitHub token resolvable',
      status: 'warning',
      message: 'No GitHub token available via $GITHUB_TOKEN or `gh auth token`',
      remediation: 'Set $GITHUB_TOKEN or run `gh auth login`',
    };
  }
  try {
    const octokit = getOctokit(token);
    const { data } = await octokit.users.getAuthenticated();
    return {
      name: 'GitHub token resolvable',
      status: 'ok',
      message: `Authenticated as @${data.login}`,
    };
  } catch (err) {
    return {
      name: 'GitHub token resolvable',
      status: 'error',
      message: `Token present but API auth failed: ${errorMessage(err)}`,
      remediation: 'Token may be expired or revoked — run `gh auth refresh` or set a fresh $GITHUB_TOKEN',
    };
  }
}

/**
 * Locate `packages/core/dist/cli.bundle.cjs` across the two runtime contexts
 * this code can run in:
 *
 *   - Dev (tsx): `__dirname` = `.../packages/core/src/commands`, bundle sits
 *     two levels up in `../../dist/cli.bundle.cjs`.
 *   - Bundled (cjs): `__dirname` = `.../packages/core/dist`, bundle sits at
 *     `./cli.bundle.cjs` in that same directory.
 */
function resolveBundlePaths(): { bundlePath: string; sourcePath: string } {
  const devBundle = path.resolve(__dirname, '../../dist/cli.bundle.cjs');
  const coDirBundle = path.resolve(__dirname, 'cli.bundle.cjs');
  const devSource = path.resolve(__dirname, '../cli.ts');
  const coDirSource = path.resolve(__dirname, '../src/cli.ts');

  // Prefer whichever resolves an existing file; fall back to dev paths so the
  // "missing" branches in checkBundleUpToDate still have a sensible path to
  // report.
  const bundlePath = fs.existsSync(devBundle) ? devBundle : fs.existsSync(coDirBundle) ? coDirBundle : devBundle;
  const sourcePath = fs.existsSync(devSource) ? devSource : fs.existsSync(coDirSource) ? coDirSource : devSource;
  return { bundlePath, sourcePath };
}

/**
 * Try `fs.statSync`; if the file is merely missing (ENOENT), return null.
 * For other fs errors (EACCES, ELOOP, ENOTDIR, …) surface the error so the
 * caller can report it instead of misdiagnosing it as "file missing."
 */
function tryStat(p: string): { stat: fs.Stats | null; error?: NodeJS.ErrnoException } {
  try {
    return { stat: fs.statSync(p) };
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { stat: null };
    return { stat: null, error: err as NodeJS.ErrnoException };
  }
}

/**
 * Bundle-freshness check only fires when the *source* file is present — that's
 * the dev-repo workflow. npm consumers install the pre-built bundle with no
 * source, so we just confirm the bundle exists.
 */
export function checkBundleUpToDate(options?: { bundlePath?: string; sourcePath?: string }): DoctorCheck {
  const resolved = resolveBundlePaths();
  const bundlePath = options?.bundlePath ?? resolved.bundlePath;
  const sourcePath = options?.sourcePath ?? resolved.sourcePath;

  const bundleResult = tryStat(bundlePath);
  const sourceResult = tryStat(sourcePath);

  if (bundleResult.error || sourceResult.error) {
    const err = bundleResult.error ?? sourceResult.error!;
    return {
      name: 'CLI bundle',
      status: 'error',
      message: `Bundle freshness check failed: ${errorMessage(err)}`,
      remediation: 'Check filesystem permissions on packages/core/dist/',
    };
  }
  const bundleStat = bundleResult.stat;
  const sourceStat = sourceResult.stat;

  if (!bundleStat && !sourceStat) {
    return {
      name: 'CLI bundle',
      status: 'warning',
      message: 'Neither cli.ts nor cli.bundle.cjs could be located',
      remediation: 'Reinstall the package or check your install location',
    };
  }
  if (!bundleStat) {
    return {
      name: 'CLI bundle',
      status: 'warning',
      message: 'dist/cli.bundle.cjs not built yet',
      remediation: 'Run `pnpm run bundle` to build the CLI bundle',
    };
  }
  if (sourceStat && sourceStat.mtimeMs > bundleStat.mtimeMs) {
    return {
      name: 'CLI bundle',
      status: 'warning',
      message: 'Source files are newer than dist/cli.bundle.cjs',
      remediation: 'Run `pnpm run bundle` to rebuild',
    };
  }
  return { name: 'CLI bundle', status: 'ok', message: 'Bundle present and up-to-date' };
}

export function checkStateFile(options?: { statePathOverride?: string }): DoctorCheck {
  const statePath = options?.statePathOverride ?? getStatePath();
  if (!fs.existsSync(statePath)) {
    return {
      name: 'state.json valid',
      status: 'ok',
      message: 'No state.json yet (first run — nothing to validate)',
    };
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const result = AgentStateSchema.safeParse(parsed);
    if (!result.success) {
      const snippet = result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return {
        name: 'state.json valid',
        status: 'error',
        message: `state.json failed schema validation — ${snippet}`,
        remediation: 'Restore from a backup in `~/.oss-autopilot/backups/` or re-run `oss-autopilot init`',
      };
    }
    const version = typeof parsed?.version === 'number' ? parsed.version : '?';
    return { name: 'state.json valid', status: 'ok', message: `state v${version} parses and validates` };
  } catch (err) {
    return {
      name: 'state.json valid',
      status: 'error',
      message: `Failed to read/parse state.json: ${errorMessage(err)}`,
      remediation: 'Restore from a backup in `~/.oss-autopilot/backups/`',
    };
  }
}

/**
 * Dynamic import of `@oss-scout/core`. Extracted so tests can inject a throwing
 * stub without mocking the module registry.
 */
export type ScoutImporter = () => Promise<unknown>;
const defaultScoutImporter: ScoutImporter = () => import('@oss-scout/core');

export async function checkScoutResolvable(importer: ScoutImporter = defaultScoutImporter): Promise<DoctorCheck> {
  // The scout package is ESM-exports-only, so `require.resolve` fails even
  // when it's installed. `import()` goes through the ESM resolver, which
  // honors `exports` maps correctly. Dynamic import only loads the package
  // on demand (not at doctor module load) and is cheap — no auth side effects.
  try {
    await importer();
    return { name: '@oss-scout/core resolvable', status: 'ok', message: 'Found on module path' };
  } catch (err) {
    // Three outcomes we want to distinguish:
    //   - "Package simply isn't installed" (missing from node_modules)
    //   - "Package is present but the install is corrupt" (bad exports map,
    //     unparseable source, missing internal file) — reinstall is the fix
    //   - "Package loaded but threw during init" — this is a scout bug
    const code = errCode(err);
    const isNotFound = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
    const isCorruptInstall =
      code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ||
      code === 'ERR_PACKAGE_IMPORT_NOT_DEFINED' ||
      code === 'ERR_INVALID_PACKAGE_CONFIG' ||
      err instanceof SyntaxError;
    const reinstallRequired = isNotFound || isCorruptInstall;
    return {
      name: '@oss-scout/core resolvable',
      status: 'error',
      message: reinstallRequired
        ? `@oss-scout/core cannot be loaded (install issue): ${errorMessage(err)}`
        : `@oss-scout/core failed to load: ${errorMessage(err)}`,
      remediation: reinstallRequired
        ? 'Reinstall dependencies (`pnpm install` or `npm install`)'
        : 'Scout loaded but threw during initialization — report this as a bug in oss-scout with the error above',
    };
  }
}

export async function checkGitHubRateLimit(preloadedToken?: string | null): Promise<DoctorCheck> {
  const token = preloadedToken !== undefined ? preloadedToken : await getGitHubTokenAsync();
  if (!token) {
    return {
      name: 'GitHub rate limit',
      status: 'warning',
      message: 'Cannot check — no token available',
      remediation: 'Set $GITHUB_TOKEN or run `gh auth login` to enable API-backed checks',
    };
  }
  try {
    const octokit = getOctokit(token);
    const { data } = await octokit.rateLimit.get();
    const core = data.resources.core;
    const resetAt = new Date(core.reset * 1000).toISOString();
    if (core.remaining < 100) {
      return {
        name: 'GitHub rate limit',
        status: 'warning',
        message: `Only ${core.remaining}/${core.limit} core requests remaining (resets at ${resetAt})`,
        remediation: 'Wait for the window to reset or use a token with a higher limit',
      };
    }
    return {
      name: 'GitHub rate limit',
      status: 'ok',
      message: `${core.remaining}/${core.limit} core requests remaining`,
    };
  } catch (err) {
    return {
      name: 'GitHub rate limit',
      status: 'error',
      message: `Failed to check rate limit: ${errorMessage(err)}`,
    };
  }
}

// ── Orchestrator ────────────────────────────────────────────────────────

/**
 * Run all diagnostic checks and return a structured report.
 *
 * Checks are run concurrently where possible. None of the checks throw — each
 * returns a `DoctorCheck` with its own status so a single failing check does
 * not abort the rest of the audit.
 */
/**
 * Run a check defensively. If it rejects or the run itself throws, convert the
 * failure into a synthetic `DoctorCheck` with status 'error' — `doctor` is the
 * tool users reach for when things are already broken, so it must never abort
 * itself because one individual check crashed.
 */
async function runCheckSafely(name: string, runner: () => Promise<DoctorCheck> | DoctorCheck): Promise<DoctorCheck> {
  try {
    return await runner();
  } catch (err) {
    return {
      name,
      status: 'error',
      message: `Check crashed unexpectedly: ${errorMessage(err)}`,
      remediation: 'This is a bug in the doctor command — please report it with the error above',
    };
  }
}

export async function runDoctor(): Promise<DoctorOutput> {
  // Pre-resolve the token once and pass it to the token-dependent checks.
  // Without this, the first call enters the async `gh auth token` branch
  // (setting `tokenFetchAttempted = true` synchronously, then yielding at the
  // `execFile` await). A second concurrent caller sees the flag set and the
  // cache still empty, and returns `null` immediately — producing a spurious
  // "no token available" warning while the first caller later resolves a valid
  // token. Empirically reproduced before this fix.
  // Best-effort token fetch — if it throws (sync or async), downstream
  // token-dependent checks still run and will report "no token available" on
  // their own. `try/catch` covers the sync-throw case; `.catch` alone would
  // not.
  let token: string | null = null;
  try {
    token = await getGitHubTokenAsync();
  } catch {
    token = null;
  }

  const checks: DoctorCheck[] = await Promise.all([
    runCheckSafely('gh CLI installed', () => checkGhCli()),
    runCheckSafely('gh CLI authenticated', () => checkGhAuth()),
    runCheckSafely('GitHub token resolvable', () => checkGitHubToken(token)),
    runCheckSafely('GitHub rate limit', () => checkGitHubRateLimit(token)),
    runCheckSafely('@oss-scout/core resolvable', () => checkScoutResolvable()),
    runCheckSafely('CLI bundle', () => checkBundleUpToDate()),
    runCheckSafely('state.json valid', () => checkStateFile()),
  ]);

  const summary = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warnings: checks.filter((c) => c.status === 'warning').length,
    errors: checks.filter((c) => c.status === 'error').length,
  };
  return { checks, summary };
}
