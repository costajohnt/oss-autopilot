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
 * GitHub API errors (rate limits, auth failures, network).
 */
export class GitHubAPIError extends OssAutopilotError {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message, 'GITHUB_API_ERROR');
    this.name = 'GitHubAPIError';
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
 * State file errors (corruption, concurrent access).
 */
export class StateError extends OssAutopilotError {
  constructor(message: string) {
    super(message, 'STATE_ERROR');
    this.name = 'StateError';
  }
}
