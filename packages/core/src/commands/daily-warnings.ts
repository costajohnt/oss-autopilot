/**
 * Non-fatal warning helpers shared by the daily phases (#1042). Split out of
 * daily.ts so the per-phase modules (closed-PR status, merged-PR notes) can
 * record warnings the same way without importing the orchestrator.
 */

import { errorMessage, getHttpStatusCode } from '../core/errors.js';
import { warn } from '../core/logger.js';
import type { DailyWarning, DailyWarningPhase } from '../formatters/json.js';

const MODULE = 'daily';

/**
 * Record a non-fatal failure: push a structured entry into the run's warnings
 * collector AND emit the existing log line. Consumers (dashboard, MCP, tests)
 * inspect `DailyOutput.warnings` so a partial run is visible beyond log noise.
 * See #1042.
 */
export function recordWarning(
  warnings: DailyWarning[],
  phase: DailyWarningPhase,
  operation: string,
  err: unknown,
  humanMessage?: string,
): void {
  const message = humanMessage ?? errorMessage(err);
  warnings.push({ phase, operation, message });
  warn(MODULE, `${operation}: ${message}`);
}

/**
 * Variant of `nonFatalCatch` that also records a structured warning. Returns
 * the fallback value on error (same semantics as `nonFatalCatch`) AND pushes
 * an entry into the collector so the failure shows up in `DailyOutput.warnings`.
 */
export function nonFatalCatchWithWarning<T>(opts: {
  warnings: DailyWarning[];
  phase: DailyWarningPhase;
  operation: string;
  fallback: T;
}): (err: unknown) => T {
  return (err: unknown): T => {
    recordWarning(opts.warnings, opts.phase, opts.operation, err);
    return opts.fallback;
  };
}

/** `HTTP 404` when the error carries a status, else undefined. */
export function httpStatusLabel(error: unknown): string | undefined {
  const status = getHttpStatusCode(error);
  return status === undefined ? undefined : `HTTP ${status}`;
}

/** 404/410: the issue or PR is gone (deleted, transferred, or now private). */
export function isGoneError(error: unknown): boolean {
  const status = getHttpStatusCode(error);
  return status === 404 || status === 410;
}

/** Warning text with the HTTP status in front when there is one. */
export function describeError(error: unknown): string {
  const label = httpStatusLabel(error);
  return label ? `${label}: ${errorMessage(error)}` : errorMessage(error);
}
