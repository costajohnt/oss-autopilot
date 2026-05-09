/**
 * Custom error type hierarchy for oss-autopilot.
 * Provides structured error codes and specific error classes
 * for different failure categories.
 *
 * Error strategy: Rate-limit and auth errors (429, 401, 403+rate-limit) always
 * propagate to the caller via isRateLimitError/isRateLimitOrAuthError.
 * Other errors degrade gracefully — modules return partial results and log warnings.
 */

import { warn } from './logger.js';

/**
 * Base error for all oss-autopilot errors.
 */
export class OssAutopilotError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'OssAutopilotError';
  }
}

/**
 * Configuration errors (missing setup, invalid config).
 */
export class ConfigurationError extends OssAutopilotError {
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
  }
}

/**
 * Input validation errors (invalid URLs, out-of-range values).
 */
export class ValidationError extends OssAutopilotError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

/**
 * Gist API scope error (token lacks the "gist" scope).
 */
export class GistPermissionError extends ConfigurationError {
  constructor(message?: string) {
    super(
      message ??
        'Your GitHub token does not have Gist permissions. ' +
          'Run `gh auth refresh -s gist` to add the required scope, ' +
          'or create a token with the "gist" scope.',
    );
    this.name = 'GistPermissionError';
  }
}

/**
 * Thrown when state.json fetched from a Gist is malformed or fails Zod
 * validation. The Gist content is preserved as a `.rejected-<ts>.json` file
 * in the local cache directory so the user can inspect or recover from it
 * before the next push overwrites the Gist with fresh state.
 *
 * See issue #1201.
 */
export class GistCorruptError extends ConfigurationError {
  constructor(
    public readonly gistId: string,
    public readonly rejectedPath: string | null,
    public readonly cause: unknown,
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    const recoverHint = rejectedPath
      ? `\nCorrupt content preserved at: ${rejectedPath}\n` +
        'Inspect or restore manually, then re-run. Falling back to a fresh state would overwrite your Gist.'
      : '\nCould not preserve the rejected content; do not push without inspecting the Gist manually.';
    super(`Gist ${gistId} state.json is corrupt or fails schema validation: ${causeMsg}${recoverHint}`);
    this.name = 'GistCorruptError';
  }
}

/**
 * Thrown when an optimistic compare-and-swap on state.json detects that
 * another process wrote the file between load and save. See issue #1030.
 *
 * Library consumers should call `stateManager.reloadIfChanged()` and
 * re-apply their mutation. The runtime `message` is phrased for CLI
 * end-users; the structured `expectedMtimeMs` / `actualMtimeMs` fields
 * are for programmatic handling.
 */
export class ConcurrencyError extends OssAutopilotError {
  constructor(
    public readonly expectedMtimeMs: number,
    public readonly actualMtimeMs: number,
  ) {
    super(
      'Another oss-autopilot process wrote state.json concurrently. ' +
        'Re-run the command to retry — the last write wins and no data was lost from the other process.',
      'CONCURRENCY_ERROR',
    );
    this.name = 'ConcurrencyError';
  }
}

/**
 * Thrown when a Gist push collides with a concurrent write from another
 * machine and the in-flight merge attempt also lost the race (#1115).
 *
 * Carries the ETag we tried to write against (`expectedEtag`) and the
 * ETag we observed during the merge refetch (`remoteEtag`) so callers /
 * tests can assert on the precise mismatch. The message is phrased for
 * end-users; `state-sync` retries from a fresh fetch.
 */
export class GistConcurrencyError extends OssAutopilotError {
  constructor(
    public readonly expectedEtag: string | null,
    public readonly remoteEtag: string | null,
  ) {
    super(
      'Another machine pushed to the state Gist while this push was in flight, and the merge attempt also collided. ' +
        'Re-run `oss-autopilot state --sync` to retry — your local mutations are still in memory.',
      'CONCURRENCY_ERROR',
    );
    this.name = 'GistConcurrencyError';
  }
}

/**
 * Extract a human-readable message from an unknown error value.
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Safely extract an HTTP status code from an unknown error (e.g. Octokit errors).
 * Returns undefined if the error doesn't have a numeric `status` property.
 */
export function getHttpStatusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
  }
  return undefined;
}

/** Check if an error is a GitHub rate limit error (429 or rate-limit 403). */
export function isRateLimitError(error: unknown): boolean {
  const status = getHttpStatusCode(error);
  if (status === 429) return true;
  if (status === 403) {
    const msg = errorMessage(error).toLowerCase();
    return msg.includes('rate limit');
  }
  return false;
}

/**
 * Match-text used to discriminate the user-resolution failure from sibling
 * `resource: 'Search', code: 'invalid'` 422s (query-too-long,
 * too-many-OR-operators, malformed qualifier). Both the structured and the
 * fallback paths gate on this pattern so the matcher's name remains accurate
 * if a future caller uses a different Search query.
 */
const USER_NOT_FOUND_SEARCH_MESSAGE = /users.*do not exist|cannot be searched/i;

/**
 * Check if an error is GitHub's "users do not exist" Search-API validation
 * failure (HTTP 422 with `resource: 'Search', code: 'invalid'` and a message
 * indicating the user couldn't be resolved). Returned when the Search API
 * can't resolve the user named in an `author:`/`user:` qualifier — the
 * typical cause is a stale or mis-typed `githubUsername` in
 * `~/.oss-autopilot/state.json`.
 *
 * Surfaced as a generic "Validation Failed" string by Octokit, which gives
 * the user no actionable signal. Callers wrap the search and rethrow this
 * as a {@link ConfigurationError} so the CLI prints the configured username
 * and points at `/setup-oss`.
 *
 * The message-text gate is load-bearing: GitHub returns the same
 * `resource`/`code` pair for other Search 422s (query too long, too many
 * ORs). Without the gate, those would silently rewrite to "your configured
 * username is wrong," which is actively misleading.
 */
export function isInvalidUserSearchError(err: unknown): boolean {
  if (getHttpStatusCode(err) !== 422) return false;
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  const errors = data && typeof data === 'object' ? (data as { errors?: unknown }).errors : undefined;
  if (Array.isArray(errors)) {
    return errors.some((e) => {
      if (!e || typeof e !== 'object') return false;
      const entry = e as { resource?: unknown; code?: unknown; message?: unknown };
      if (entry.resource !== 'Search' || entry.code !== 'invalid') return false;
      // The Search API includes a per-error `message` for this case. When
      // present, gate on it to avoid matching sibling validation failures
      // that share the resource/code pair. When absent, fall back to the
      // top-level message check below — some serializations drop the
      // per-entry message but keep it on the response.
      if (typeof entry.message === 'string') {
        return USER_NOT_FOUND_SEARCH_MESSAGE.test(entry.message);
      }
      return USER_NOT_FOUND_SEARCH_MESSAGE.test(errorMessage(err));
    });
  }
  // Fallback for serialized errors that lost the structured `response.data`
  // (e.g. messages re-thrown across boundaries). The Search API's own copy
  // is stable enough to match against.
  return USER_NOT_FOUND_SEARCH_MESSAGE.test(errorMessage(err));
}

/** Return true for errors that should propagate (not degrade gracefully): rate limits, auth failures, abuse detection. */
export function isRateLimitOrAuthError(err: unknown): boolean {
  const status = getHttpStatusCode(err);
  if (status === 401 || status === 429) return true;
  if (status === 403) {
    const msg = errorMessage(err).toLowerCase();
    return msg.includes('rate limit') || msg.includes('abuse detection');
  }
  return false;
}

/**
 * Check if an error is a transient network/server-side failure that's safe
 * to retry or fall back from (vs. a permanent error that should surface).
 *
 * Returns true for:
 * - Node socket errors: ECONNRESET, ETIMEDOUT, ENETUNREACH, ENOTFOUND, ECONNREFUSED
 * - HTTP 5xx (server errors)
 * - AbortError (timeout)
 *
 * Returns false for everything else (including 4xx, schema errors, config errors).
 *
 * Used by {@link getStateManagerAsync} to decide whether a Gist init failure
 * is recoverable enough to silently fall back to local-only mode (#1202).
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = getHttpStatusCode(err);
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  // Node socket-level errors expose `code`
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENETUNREACH' ||
      code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' ||
      code === 'EAI_AGAIN'
    ) {
      return true;
    }
  }
  // Octokit's RequestError surfaces the underlying name; fetch timeout is AbortError
  const name = (err as { name?: unknown }).name;
  if (typeof name === 'string' && (name === 'AbortError' || name === 'TimeoutError')) return true;
  return false;
}

/**
 * Build a `.catch()` handler for the "non-fatal parallel fetch" pattern used
 * by daily.ts and dashboard-data.ts (#960). When a sibling fetch fails during
 * a bulk-parallel orchestration, we want:
 *
 * - rate-limit / auth errors to propagate (those abort the whole run — the
 *   user needs to see them), and
 * - every other error to log a warning and fall back to a safe default so
 *   the other siblings can still succeed.
 *
 * Inline at each call site, this is ~4 lines of boilerplate repeated 10+
 * times. Consolidated here so the rate-limit-rethrow rule lives in exactly
 * one place.
 *
 * @example
 *   prMonitor.fetchRecentlyClosedPRs().catch(
 *     nonFatalCatch({ module: MODULE, label: 'fetch recently closed PRs', fallback: [] as ClosedPR[] })
 *   );
 */
export function nonFatalCatch<T>(params: { module: string; label: string; fallback: T }): (err: unknown) => T {
  return (err: unknown) => {
    if (isRateLimitOrAuthError(err)) throw err;
    warn(params.module, `Failed to ${params.label}: ${errorMessage(err)}`);
    return params.fallback;
  };
}

/**
 * Map an unknown error to a structured ErrorCode for JSON output.
 * Checks custom error classes, HTTP status codes (Octokit errors),
 * and error message patterns in priority order.
 */
export function resolveErrorCode(err: unknown): import('../formatters/json.js').ErrorCode {
  // Check our custom error classes first
  if (err instanceof ConfigurationError) return 'CONFIGURATION';
  if (err instanceof ValidationError) return 'VALIDATION';
  if (err instanceof ConcurrencyError) return 'CONCURRENCY';
  if (err instanceof GistConcurrencyError) return 'CONCURRENCY';

  // Check HTTP status codes (Octokit errors)
  const status = getHttpStatusCode(err);
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) {
    const msg = errorMessage(err).toLowerCase();
    if (msg.includes('rate limit') || msg.includes('abuse detection')) return 'RATE_LIMITED';
    return 'AUTH_REQUIRED';
  }
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';

  // Check error message patterns
  const msg = errorMessage(err).toLowerCase();
  if (
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed')
  )
    return 'NETWORK';
  if (msg.includes('state') && (msg.includes('corrupt') || msg.includes('invalid'))) return 'STATE_CORRUPTED';

  return 'UNKNOWN';
}
