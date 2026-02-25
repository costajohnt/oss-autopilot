import { describe, it, expect } from 'vitest';
import {
  OssAutopilotError,
  ConfigurationError,
  GitHubAPIError,
  ValidationError,
  StateError,
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

  describe('GitHubAPIError', () => {
    it('has correct name, code, and message', () => {
      const err = new GitHubAPIError('rate limited', 429);
      expect(err.name).toBe('GitHubAPIError');
      expect(err.code).toBe('GITHUB_API_ERROR');
      expect(err.message).toBe('rate limited');
    });

    it('stores the HTTP status', () => {
      const err = new GitHubAPIError('not found', 404);
      expect(err.status).toBe(404);
    });

    it('allows undefined status', () => {
      const err = new GitHubAPIError('network error');
      expect(err.status).toBeUndefined();
    });

    it('is an instance of OssAutopilotError and Error', () => {
      const err = new GitHubAPIError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(OssAutopilotError);
      expect(err).toBeInstanceOf(GitHubAPIError);
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

  describe('StateError', () => {
    it('has correct name, code, and message', () => {
      const err = new StateError('corrupt state');
      expect(err.name).toBe('StateError');
      expect(err.code).toBe('STATE_ERROR');
      expect(err.message).toBe('corrupt state');
    });

    it('is an instance of OssAutopilotError and Error', () => {
      const err = new StateError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(OssAutopilotError);
      expect(err).toBeInstanceOf(StateError);
    });
  });

  describe('instanceof checks across hierarchy', () => {
    it('all error types are instances of Error', () => {
      const errors = [
        new OssAutopilotError('test', 'TEST'),
        new ConfigurationError('test'),
        new GitHubAPIError('test'),
        new ValidationError('test'),
        new StateError('test'),
      ];
      for (const err of errors) {
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(OssAutopilotError);
      }
    });

    it('subtypes are not instances of each other', () => {
      const configErr = new ConfigurationError('test');
      const validationErr = new ValidationError('test');
      const stateErr = new StateError('test');
      const githubErr = new GitHubAPIError('test');

      expect(configErr).not.toBeInstanceOf(ValidationError);
      expect(configErr).not.toBeInstanceOf(StateError);
      expect(configErr).not.toBeInstanceOf(GitHubAPIError);
      expect(validationErr).not.toBeInstanceOf(ConfigurationError);
      expect(stateErr).not.toBeInstanceOf(ValidationError);
      expect(githubErr).not.toBeInstanceOf(StateError);
    });
  });
});
