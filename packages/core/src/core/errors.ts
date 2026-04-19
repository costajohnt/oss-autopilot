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
