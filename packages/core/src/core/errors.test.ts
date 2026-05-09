import { describe, it, expect } from 'vitest';
import {
  OssAutopilotError,
  ConfigurationError,
  ValidationError,
  GistCorruptError,
  errorMessage,
  getHttpStatusCode,
  isInvalidUserSearchError,
  resolveErrorCode,
  isTransientNetworkError,
} from './errors.js';

describe('Custom Error Hierarchy', () => {
  describe('OssAutopilotError', () => {
    it('has correct name, code, and message', () => {
      const err = new OssAutopilotError('base error', 'TEST_CODE');
      expect(err.name).toBe('OssAutopilotError');
      expect(err.code).toBe('TEST_CODE');
      expect(err.message).toBe('base error');
    });

    it('is an instance of Error', () => {
      const err = new OssAutopilotError('test', 'TEST');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(OssAutopilotError);
    });
  });

  describe('ConfigurationError', () => {
    it('has correct name, code, and message', () => {
      const err = new ConfigurationError('missing config');
      expect(err.name).toBe('ConfigurationError');
      expect(err.code).toBe('CONFIGURATION_ERROR');
      expect(err.message).toBe('missing config');
    });

    it('is an instance of OssAutopilotError and Error', () => {
      const err = new ConfigurationError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(OssAutopilotError);
      expect(err).toBeInstanceOf(ConfigurationError);
    });
  });

  describe('ValidationError', () => {
    it('has correct name, code, and message', () => {
      const err = new ValidationError('invalid URL');
      expect(err.name).toBe('ValidationError');
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toBe('invalid URL');
    });

    it('is an instance of OssAutopilotError and Error', () => {
      const err = new ValidationError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(OssAutopilotError);
      expect(err).toBeInstanceOf(ValidationError);
    });
  });

  describe('instanceof checks across hierarchy', () => {
    it('all error types are instances of Error', () => {
      const errors = [
        new OssAutopilotError('test', 'TEST'),
        new ConfigurationError('test'),
        new ValidationError('test'),
      ];
      for (const err of errors) {
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(OssAutopilotError);
      }
    });

    it('subtypes are not instances of each other', () => {
      const configErr = new ConfigurationError('test');
      const validationErr = new ValidationError('test');

      expect(configErr).not.toBeInstanceOf(ValidationError);
      expect(validationErr).not.toBeInstanceOf(ConfigurationError);
    });
  });
});

describe('errorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(errorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('extracts message from custom error subclasses', () => {
    expect(errorMessage(new ValidationError('bad input'))).toBe('bad input');
  });

  it('converts string to string', () => {
    expect(errorMessage('string error')).toBe('string error');
  });

  it('converts null to "null"', () => {
    expect(errorMessage(null)).toBe('null');
  });

  it('converts undefined to "undefined"', () => {
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('converts number to string', () => {
    expect(errorMessage(42)).toBe('42');
  });
});

describe('getHttpStatusCode', () => {
  it('extracts numeric status from error-like objects', () => {
    expect(getHttpStatusCode({ status: 404 })).toBe(404);
    expect(getHttpStatusCode({ status: 500, message: 'fail' })).toBe(500);
  });

  it('returns undefined for non-numeric status', () => {
    expect(getHttpStatusCode({ status: 'not a number' })).toBeUndefined();
  });

  it('returns undefined for NaN and Infinity status', () => {
    expect(getHttpStatusCode({ status: NaN })).toBeUndefined();
    expect(getHttpStatusCode({ status: Infinity })).toBeUndefined();
  });

  it('returns undefined for objects without status', () => {
    expect(getHttpStatusCode(new Error('no status'))).toBeUndefined();
    expect(getHttpStatusCode({ code: 404 })).toBeUndefined();
  });

  it('returns undefined for null and undefined', () => {
    expect(getHttpStatusCode(null)).toBeUndefined();
    expect(getHttpStatusCode(undefined)).toBeUndefined();
  });

  it('returns undefined for primitives', () => {
    expect(getHttpStatusCode('string')).toBeUndefined();
    expect(getHttpStatusCode(42)).toBeUndefined();
  });
});

describe('isInvalidUserSearchError (#1323)', () => {
  it('matches a 422 Search/invalid error whose entry message indicates user-resolution failure', () => {
    const err = Object.assign(new Error('Validation Failed'), {
      status: 422,
      response: {
        data: {
          message: 'Validation Failed',
          errors: [
            {
              resource: 'Search',
              field: 'q',
              code: 'invalid',
              message:
                'The listed users cannot be searched either because the users do not exist or you do not have permission to view the users.',
            },
          ],
        },
      },
    });
    expect(isInvalidUserSearchError(err)).toBe(true);
  });

  it('matches when entry message is missing but the top-level error message carries the signal', () => {
    // Some Octokit serializations drop the per-entry message but keep it
    // assembled in the Error's top-level message. The matcher falls back to
    // checking the top-level message in that case.
    const err = Object.assign(
      new Error(
        'Validation Failed: The listed users cannot be searched either because the users do not exist or you do not have permission to view the users.',
      ),
      {
        status: 422,
        response: {
          data: { errors: [{ resource: 'Search', field: 'q', code: 'invalid' }] },
        },
      },
    );
    expect(isInvalidUserSearchError(err)).toBe(true);
  });

  it('matches via the message fallback when response.data is missing', () => {
    // Octokit errors can lose the structured `response.data` after a rethrow
    // boundary. The message string copies the API "users do not exist" line,
    // so we keep that path as a substring fallback.
    const err = Object.assign(
      new Error(
        'Validation Failed: The listed users cannot be searched either because the users do not exist or you do not have permission to view the users.',
      ),
      { status: 422 },
    );
    expect(isInvalidUserSearchError(err)).toBe(true);
  });

  it('does not match Search/invalid 422s for unrelated reasons (query too long, too many ORs)', () => {
    // GitHub returns the same resource/code pair for other Search validation
    // failures. Without the message-text gate, those would silently rewrite
    // to "your configured username is wrong" which is actively misleading.
    const queryTooLong = Object.assign(new Error('Validation Failed'), {
      status: 422,
      response: {
        data: {
          errors: [
            {
              resource: 'Search',
              field: 'q',
              code: 'invalid',
              message: 'The search is longer than 256 characters.',
            },
          ],
        },
      },
    });
    expect(isInvalidUserSearchError(queryTooLong)).toBe(false);

    const tooManyOperators = Object.assign(new Error('Validation Failed'), {
      status: 422,
      response: {
        data: {
          errors: [
            {
              resource: 'Search',
              field: 'q',
              code: 'invalid',
              message: 'The search contains only logical operators (AND / OR / NOT) without any search terms.',
            },
          ],
        },
      },
    });
    expect(isInvalidUserSearchError(tooManyOperators)).toBe(false);
  });

  it('does not match unrelated 422 validation errors with a different resource', () => {
    const err = Object.assign(new Error('Validation Failed'), {
      status: 422,
      response: {
        data: { errors: [{ resource: 'Issue', field: 'title', code: 'missing' }] },
      },
    });
    expect(isInvalidUserSearchError(err)).toBe(false);
  });

  it('does not match non-422 errors', () => {
    expect(isInvalidUserSearchError(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(false);
    expect(isInvalidUserSearchError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe(false);
  });

  it('returns false for null/undefined/primitives', () => {
    expect(isInvalidUserSearchError(null)).toBe(false);
    expect(isInvalidUserSearchError(undefined)).toBe(false);
    expect(isInvalidUserSearchError('Validation Failed')).toBe(false);
  });
});

describe('resolveErrorCode', () => {
  it('returns CONFIGURATION for ConfigurationError', () => {
    expect(resolveErrorCode(new ConfigurationError('missing setup'))).toBe('CONFIGURATION');
  });

  it('returns VALIDATION for ValidationError', () => {
    expect(resolveErrorCode(new ValidationError('bad url'))).toBe('VALIDATION');
  });

  it('returns AUTH_REQUIRED for 401 status', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(resolveErrorCode(err)).toBe('AUTH_REQUIRED');
  });

  it('returns RATE_LIMITED for 429 status', () => {
    const err = Object.assign(new Error('Too many requests'), { status: 429 });
    expect(resolveErrorCode(err)).toBe('RATE_LIMITED');
  });

  it('returns RATE_LIMITED for 403 with rate limit message', () => {
    const err = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    expect(resolveErrorCode(err)).toBe('RATE_LIMITED');
  });

  it('returns RATE_LIMITED for 403 with abuse detection message', () => {
    const err = Object.assign(new Error('You have triggered an abuse detection mechanism'), {
      status: 403,
    });
    expect(resolveErrorCode(err)).toBe('RATE_LIMITED');
  });

  it('returns AUTH_REQUIRED for 403 without rate limit message', () => {
    const err = Object.assign(new Error('Resource not accessible'), { status: 403 });
    expect(resolveErrorCode(err)).toBe('AUTH_REQUIRED');
  });

  it('returns NOT_FOUND for 404 status', () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    expect(resolveErrorCode(err)).toBe('NOT_FOUND');
  });

  it('returns NETWORK for connection errors', () => {
    expect(resolveErrorCode(new Error('getaddrinfo ENOTFOUND api.github.com'))).toBe('NETWORK');
    expect(resolveErrorCode(new Error('connect ECONNREFUSED'))).toBe('NETWORK');
    expect(resolveErrorCode(new Error('read ECONNRESET'))).toBe('NETWORK');
    expect(resolveErrorCode(new Error('connect ETIMEDOUT'))).toBe('NETWORK');
    expect(resolveErrorCode(new Error('fetch failed'))).toBe('NETWORK');
  });

  it('returns STATE_CORRUPTED for state corruption messages', () => {
    expect(resolveErrorCode(new Error('state file is corrupt'))).toBe('STATE_CORRUPTED');
    expect(resolveErrorCode(new Error('invalid state data'))).toBe('STATE_CORRUPTED');
  });

  it('returns UNKNOWN for unrecognized errors', () => {
    expect(resolveErrorCode(new Error('something unexpected'))).toBe('UNKNOWN');
    expect(resolveErrorCode('string error')).toBe('UNKNOWN');
    expect(resolveErrorCode(42)).toBe('UNKNOWN');
    expect(resolveErrorCode(null)).toBe('UNKNOWN');
  });
});

describe('GistCorruptError (#1201)', () => {
  it('extends ConfigurationError so callers using existing config-error checks surface it', () => {
    const err = new GistCorruptError('abc123', '/tmp/state-cache.json.rejected-1', new Error('bad json'));
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err).toBeInstanceOf(OssAutopilotError);
    expect(err.name).toBe('GistCorruptError');
  });

  it('embeds the gist id, rejected path, and underlying cause in the message', () => {
    const cause = new Error('Unexpected token');
    const err = new GistCorruptError('gist-xyz', '/tmp/cache.rejected-123', cause);
    expect(err.message).toContain('gist-xyz');
    expect(err.message).toContain('/tmp/cache.rejected-123');
    expect(err.message).toContain('Unexpected token');
    expect(err.cause).toBe(cause);
  });

  it('warns when content could not be preserved (rejectedPath null)', () => {
    const err = new GistCorruptError('gist-xyz', null, new Error('bad'));
    expect(err.message).toContain('Could not preserve');
  });
});

describe('isTransientNetworkError (#1202)', () => {
  it('returns true for Node socket errors', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) {
      const err = Object.assign(new Error('socket'), { code });
      expect(isTransientNetworkError(err)).toBe(true);
    }
  });

  it('returns true for HTTP 5xx errors', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      const err = Object.assign(new Error('server'), { status });
      expect(isTransientNetworkError(err)).toBe(true);
    }
  });

  it('returns true for AbortError and TimeoutError', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(isTransientNetworkError(abort)).toBe(true);
    expect(isTransientNetworkError(timeout)).toBe(true);
  });

  it('returns false for HTTP 4xx errors (auth, permission, not-found)', () => {
    for (const status of [400, 401, 403, 404, 422, 429]) {
      const err = Object.assign(new Error('client'), { status });
      expect(isTransientNetworkError(err)).toBe(false);
    }
  });

  it('returns false for plain errors and non-error inputs', () => {
    expect(isTransientNetworkError(new Error('boom'))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError('string')).toBe(false);
    expect(isTransientNetworkError(42)).toBe(false);
  });

  it('returns false for our own custom errors (config, validation)', () => {
    expect(isTransientNetworkError(new ConfigurationError('bad config'))).toBe(false);
    expect(isTransientNetworkError(new ValidationError('bad input'))).toBe(false);
  });
});
