/**
 * Tests for JSON output formatter
 * Locks down the --json contract used by the plugin layer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jsonSuccess, jsonError, outputJson, outputJsonError } from './json.js';

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('jsonSuccess', () => {
  it('should wrap data with success envelope', () => {
    const result = jsonSuccess({ foo: 1 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ foo: 1 });
    expect(result.timestamp).toEqual(expect.any(String));
  });

  it('should include ISO 8601 timestamp', () => {
    const result = jsonSuccess('test');
    expect(result.timestamp).toMatch(ISO_8601_REGEX);
  });

  it('should not include error field', () => {
    const result = jsonSuccess({ foo: 1 });
    expect(result.error).toBeUndefined();
  });

  it('should handle null data', () => {
    const result = jsonSuccess(null);
    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });

  it('should handle array data', () => {
    const result = jsonSuccess([1, 2, 3]);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([1, 2, 3]);
  });
});

describe('jsonError', () => {
  it('should wrap error message with failure envelope', () => {
    const result = jsonError('boom');
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    expect(result.timestamp).toEqual(expect.any(String));
  });

  it('should not include data field', () => {
    const result = jsonError('boom');
    expect(result.data).toBeUndefined();
  });

  it('should include ISO 8601 timestamp', () => {
    const result = jsonError('boom');
    expect(result.timestamp).toMatch(ISO_8601_REGEX);
  });
});

describe('outputJson', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('should write JSON success to stdout', () => {
    outputJson({ key: 'value' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.success).toBe(true);
    expect(output.data).toEqual({ key: 'value' });
    expect(output.timestamp).toMatch(ISO_8601_REGEX);
  });

  it('should output pretty-printed JSON', () => {
    outputJson({ key: 'value' });
    const raw = logSpy.mock.calls[0][0] as string;
    expect(raw).toContain('\n');
    expect(raw).toContain('  '); // 2-space indentation
  });
});

describe('outputJsonError', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('should write JSON error to stdout', () => {
    outputJsonError('something broke');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.success).toBe(false);
    expect(output.error).toBe('something broke');
    expect(output.timestamp).toMatch(ISO_8601_REGEX);
  });

  it('should never put success inside data', () => {
    outputJson({ foo: 'bar' });
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    // The contract: success lives at the envelope level, not inside data
    expect(output.data).toEqual({ foo: 'bar' });
    expect(output.data).not.toHaveProperty('success');
  });
});
