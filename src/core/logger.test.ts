import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to test the module's internal state, so we import and reset between tests.
// The module uses a private `debugEnabled` flag — we reset it by re-importing or
// calling enableDebug / checking isDebugEnabled.

let loggerModule: typeof import('./logger.js');

describe('logger', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Fresh import to reset module-level state
    vi.resetModules();
    loggerModule = await import('./logger.js');
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('enableDebug / isDebugEnabled', () => {
    it('should default to disabled', () => {
      expect(loggerModule.isDebugEnabled()).toBe(false);
    });

    it('should enable debug mode', () => {
      loggerModule.enableDebug();
      expect(loggerModule.isDebugEnabled()).toBe(true);
    });
  });

  describe('debug', () => {
    it('should output nothing when debug is disabled', () => {
      loggerModule.debug('test', 'hello');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should output to stderr when debug is enabled', () => {
      loggerModule.enableDebug();
      loggerModule.debug('test-module', 'some message');
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const output = consoleErrorSpy.mock.calls[0][0] as string;
      expect(output).toContain('[DEBUG]');
      expect(output).toContain('[test-module]');
      expect(output).toContain('some message');
    });

    it('should include a timestamp in ISO format', () => {
      loggerModule.enableDebug();
      loggerModule.debug('mod', 'msg');
      const output = consoleErrorSpy.mock.calls[0][0] as string;
      // Should match ISO timestamp pattern like [2024-01-15T10:30:00.000Z]
      expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should pass extra args through', () => {
      loggerModule.enableDebug();
      loggerModule.debug('mod', 'msg', { key: 'value' }, 42);
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      expect(consoleErrorSpy.mock.calls[0][1]).toEqual({ key: 'value' });
      expect(consoleErrorSpy.mock.calls[0][2]).toBe(42);
    });
  });

  describe('warn', () => {
    it('should always output, even when debug is disabled', () => {
      expect(loggerModule.isDebugEnabled()).toBe(false);
      loggerModule.warn('test-module', 'warning message');
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const output = consoleErrorSpy.mock.calls[0][0] as string;
      expect(output).toContain('[WARN]');
      expect(output).toContain('[test-module]');
      expect(output).toContain('warning message');
    });

    it('should also output when debug is enabled', () => {
      loggerModule.enableDebug();
      loggerModule.warn('mod', 'a warning');
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const output = consoleErrorSpy.mock.calls[0][0] as string;
      expect(output).toContain('[WARN]');
    });
  });

  describe('timed', () => {
    it('should return the result without logging when debug is disabled', async () => {
      const result = await loggerModule.timed('mod', 'op', async () => 42);
      expect(result).toBe(42);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should return the result and log duration when debug is enabled', async () => {
      loggerModule.enableDebug();
      const result = await loggerModule.timed('mod', 'op', async () => 'hello');
      expect(result).toBe('hello');
      // Should have logged a "completed in Xms" message
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls[0][0] as string;
      expect(output).toContain('op completed in');
      expect(output).toContain('ms');
    });

    it('should log "failed after" and re-throw on error when debug is enabled', async () => {
      loggerModule.enableDebug();
      const err = new Error('boom');
      await expect(
        loggerModule.timed('mod', 'op', async () => { throw err; })
      ).rejects.toThrow('boom');
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls[0][0] as string;
      expect(output).toContain('op failed after');
      expect(output).toContain('ms');
    });

    it('should re-throw on error without logging when debug is disabled', async () => {
      const err = new Error('boom');
      await expect(
        loggerModule.timed('mod', 'op', async () => { throw err; })
      ).rejects.toThrow('boom');
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
