/**
 * Custom error type hierarchy for oss-autopilot.
 * Provides structured error codes and specific error classes
 * for different failure categories.
 */

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
