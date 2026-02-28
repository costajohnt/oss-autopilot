import { describe, it, expect } from 'vitest';
import { OssAutopilotError, ConfigurationError, ValidationError } from './errors.js';

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
