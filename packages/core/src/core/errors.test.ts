import { describe, it, expect } from 'vitest';
import { OssAutopilotError, ConfigurationError, ValidationError, errorMessage, getHttpStatusCode } from './errors.js';

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
