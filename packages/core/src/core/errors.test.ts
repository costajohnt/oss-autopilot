import { describe, it, expect } from 'vitest';
import {
  OssAutopilotError,
  ConfigurationError,
  ValidationError,
  errorMessage,
  getHttpStatusCode,
  resolveErrorCode,
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
