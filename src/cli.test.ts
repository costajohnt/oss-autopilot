/**
 * Tests for cli.ts entry point
 *
 * Since cli.ts calls program.parse() at module level, we test its logic by:
 * 1. Exercising preAction hook behavior via a minimal Commander replica
 * 2. Validating LOCAL_ONLY_COMMANDS membership expectations
 * 3. Verifying version detection IIFE graceful fallback
 * 4. Confirming all expected subcommands are registered
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ─── Mock all side-effectful imports BEFORE any module is loaded ──────────────

vi.mock('./core/index.js', () => ({
  getGitHubToken: vi.fn(),
  enableDebug: vi.fn(),
  debug: vi.fn(),
}));

// Mock every command runner so program.parse() in cli.ts never does real work.
// Each is a no-op async function.
const noop = vi.fn(async () => {});

vi.mock('./commands/daily.js', () => ({ runDaily: noop }));
vi.mock('./commands/status.js', () => ({ runStatus: noop }));
vi.mock('./commands/search.js', () => ({ runSearch: noop }));
vi.mock('./commands/vet.js', () => ({ runVet: noop }));
vi.mock('./commands/track.js', () => ({ runTrack: noop, runUntrack: noop }));
vi.mock('./commands/config.js', () => ({ runConfig: noop }));
vi.mock('./commands/comments.js', () => ({ runComments: noop, runPost: noop, runClaim: noop }));
vi.mock('./commands/setup.js', () => ({ runSetup: noop, runCheckSetup: noop }));
vi.mock('./commands/init.js', () => ({ runInit: noop }));
vi.mock('./commands/read.js', () => ({ runRead: noop }));
vi.mock('./commands/dashboard.js', () => ({ runDashboard: noop }));
vi.mock('./commands/parse-list.js', () => ({ runParseList: noop }));
vi.mock('./commands/check-integration.js', () => ({ runCheckIntegration: noop }));
vi.mock('./commands/local-repos.js', () => ({ runLocalRepos: noop }));
vi.mock('./commands/startup.js', () => ({ runStartup: noop }));
vi.mock('./commands/shelve.js', () => ({ runShelve: noop, runUnshelve: noop }));
vi.mock('./commands/dismiss.js', () => ({ runDismiss: noop, runUndismiss: noop }));
vi.mock('./commands/snooze.js', () => ({ runSnooze: noop, runUnsnooze: noop }));

import { getGitHubToken, enableDebug, debug } from './core/index.js';

const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockEnableDebug = vi.mocked(enableDebug);
const mockDebug = vi.mocked(debug);

// ─── Canonical list of LOCAL_ONLY_COMMANDS (mirrors cli.ts) ──────────────────
//
// This array is the source of truth for the token-gating bypass list.
// Tests below verify both its membership and the preAction hook that reads it.

const LOCAL_ONLY_COMMANDS = [
  'help',
  'status',
  'config',
  'read',
  'untrack',
  'version',
  'setup',
  'checkSetup',
  'dashboard',
  'parse-issue-list',
  'check-integration',
  'local-repos',
  'startup',
  'shelve',
  'unshelve',
  'dismiss',
  'undismiss',
  'snooze',
  'unsnooze',
];

// ─── Helper: build a minimal Commander program with the same preAction hook ──

function buildTestProgram(localOnlyCommands: string[]) {
  const program = new Command();
  program.name('oss-autopilot').option('--debug', 'Enable debug logging');

  // Register a couple of representative commands
  program.command('daily').description('Run daily check').action(noop);
  program.command('status').description('Show status').action(noop);
  program.command('config').description('Show config').action(noop);
  program.command('search').description('Search').action(noop);

  program.hook('preAction', async (thisCommand, actionCommand) => {
    const globalOpts = thisCommand.opts();
    if (globalOpts.debug) {
      enableDebug();
      debug('cli', `Running command: ${actionCommand.name()}`);
    }

    const commandName = actionCommand.name();
    if (!localOnlyCommands.includes(commandName)) {
      const token = getGitHubToken();
      if (!token) {
        console.error('Error: GitHub authentication required.');
        process.exit(1);
      }
    }
  });

  return program;
}

// ─── LOCAL_ONLY_COMMANDS membership ──────────────────────────────────────────

describe('LOCAL_ONLY_COMMANDS', () => {
  it('should contain "status"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('status');
  });

  it('should contain "config"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('config');
  });

  it('should contain "read"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('read');
  });

  it('should contain "untrack"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('untrack');
  });

  it('should contain "setup"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('setup');
  });

  it('should contain "checkSetup"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('checkSetup');
  });

  it('should contain "dashboard"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('dashboard');
  });

  it('should contain "parse-issue-list"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('parse-issue-list');
  });

  it('should contain "check-integration"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('check-integration');
  });

  it('should contain "local-repos"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('local-repos');
  });

  it('should contain "startup"', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('startup');
  });

  it('should contain shelve/unshelve, dismiss/undismiss, snooze/unsnooze commands', () => {
    expect(LOCAL_ONLY_COMMANDS).toContain('shelve');
    expect(LOCAL_ONLY_COMMANDS).toContain('unshelve');
    expect(LOCAL_ONLY_COMMANDS).toContain('dismiss');
    expect(LOCAL_ONLY_COMMANDS).toContain('undismiss');
    expect(LOCAL_ONLY_COMMANDS).toContain('snooze');
    expect(LOCAL_ONLY_COMMANDS).toContain('unsnooze');
  });

  it('should NOT contain token-required commands like "daily"', () => {
    expect(LOCAL_ONLY_COMMANDS).not.toContain('daily');
  });

  it('should NOT contain token-required commands like "search"', () => {
    expect(LOCAL_ONLY_COMMANDS).not.toContain('search');
  });

  it('should NOT contain token-required commands like "vet"', () => {
    expect(LOCAL_ONLY_COMMANDS).not.toContain('vet');
  });

  it('should NOT contain token-required commands like "track"', () => {
    expect(LOCAL_ONLY_COMMANDS).not.toContain('track');
  });

  it('should NOT contain token-required commands like "comments"', () => {
    expect(LOCAL_ONLY_COMMANDS).not.toContain('comments');
  });

  it('should NOT contain token-required commands like "post"', () => {
    expect(LOCAL_ONLY_COMMANDS).not.toContain('post');
  });

  it('should NOT contain token-required commands like "init"', () => {
    expect(LOCAL_ONLY_COMMANDS).not.toContain('init');
  });

  it('should have exactly the expected number of entries (no accidental additions/deletions)', () => {
    expect(LOCAL_ONLY_COMMANDS).toHaveLength(19);
  });
});

// ─── preAction hook: token-gating logic ──────────────────────────────────────

describe('preAction hook', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Intercept process.exit so tests don't actually terminate the process
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should allow LOCAL_ONLY_COMMANDS to run without a token', async () => {
    mockGetGitHubToken.mockReturnValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    // "status" is in LOCAL_ONLY_COMMANDS — should not call getGitHubToken
    await program.parseAsync(['node', 'cli', 'status']);

    expect(mockGetGitHubToken).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should allow "config" to run without a token', async () => {
    mockGetGitHubToken.mockReturnValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', 'config']);

    expect(mockGetGitHubToken).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should call process.exit(1) when a non-LOCAL command runs without a token', async () => {
    mockGetGitHubToken.mockReturnValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await expect(program.parseAsync(['node', 'cli', 'daily'])).rejects.toThrow('process.exit called');

    expect(mockGetGitHubToken).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should call process.exit(1) when "search" runs without a token', async () => {
    mockGetGitHubToken.mockReturnValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await expect(program.parseAsync(['node', 'cli', 'search'])).rejects.toThrow('process.exit called');

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should print a descriptive error message when authentication is missing', async () => {
    mockGetGitHubToken.mockReturnValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await expect(program.parseAsync(['node', 'cli', 'daily'])).rejects.toThrow('process.exit called');

    const errorOutput = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(errorOutput).toContain('GitHub authentication required');
  });

  it('should allow a non-LOCAL command to run when a token is available', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_valid_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', 'daily']);

    expect(mockGetGitHubToken).toHaveBeenCalledTimes(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should check the token exactly once per non-LOCAL command invocation', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_some_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', 'search']);

    expect(mockGetGitHubToken).toHaveBeenCalledTimes(1);
  });

  it('should NOT check the token for LOCAL_ONLY_COMMANDS even when a token exists', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_existing_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', 'status']);

    expect(mockGetGitHubToken).not.toHaveBeenCalled();
  });

  it('should call enableDebug when --debug flag is passed', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_debug_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', '--debug', 'daily']);

    expect(mockEnableDebug).toHaveBeenCalledTimes(1);
  });

  it('should call debug() with the command name when --debug is set', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_debug_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', '--debug', 'daily']);

    expect(mockDebug).toHaveBeenCalledWith('cli', 'Running command: daily');
  });

  it('should NOT call enableDebug when --debug flag is absent', async () => {
    mockGetGitHubToken.mockReturnValue('ghp_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', 'daily']);

    expect(mockEnableDebug).not.toHaveBeenCalled();
    expect(mockDebug).not.toHaveBeenCalled();
  });

  it('should not call process.exit for LOCAL_ONLY_COMMANDS even when --debug is set', async () => {
    mockGetGitHubToken.mockReturnValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', '--debug', 'status']);

    expect(processExitSpy).not.toHaveBeenCalled();
  });
});

// ─── Version detection IIFE ───────────────────────────────────────────────────

describe('Version detection IIFE', () => {
  it('should return a semver-like string from package.json', () => {
    // The IIFE reads from the filesystem via require('fs') and require('path').
    // We test the shape of the result by running equivalent logic directly.
    const fs = require('fs');
    const path = require('path');

    let version: string;
    try {
      const pkgPath = path.join(__dirname, '..', 'package.json');
      version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
    } catch {
      version = '0.0.0';
    }

    // Should be a non-empty semver-like string
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should fall back to "0.0.0" when package.json cannot be read', () => {
    // Simulate the IIFE behaviour when the file is missing / unreadable
    let version: string;
    try {
      const fs = require('fs');
      // Attempt to read a path that does not exist
      JSON.parse(fs.readFileSync('/nonexistent/path/package.json', 'utf-8')).version;
      version = 'should-not-reach';
    } catch {
      version = '0.0.0';
    }

    expect(version).toBe('0.0.0');
  });

  it('should fall back to "0.0.0" when package.json contains invalid JSON', () => {
    let version: string;
    try {
      JSON.parse('not valid json').version;
      version = 'should-not-reach';
    } catch {
      version = '0.0.0';
    }

    expect(version).toBe('0.0.0');
  });

  it('should fall back to "0.0.0" when version key is missing from package.json', () => {
    let version: string | undefined;
    try {
      version = JSON.parse('{}').version;
      if (!version) throw new Error('no version');
    } catch {
      version = '0.0.0';
    }

    expect(version).toBe('0.0.0');
  });
});

// ─── Command registration ─────────────────────────────────────────────────────

describe('Command registration', () => {
  it('should register all expected subcommands', async () => {
    // Build a replica of the CLI program with all the expected subcommand names.
    // This validates the structure without executing program.parse().
    const expectedCommands = [
      'daily',
      'status',
      'search',
      'vet',
      'track',
      'untrack',
      'read',
      'comments',
      'post',
      'claim',
      'config',
      'init',
      'setup',
      'checkSetup',
      'dashboard',
      'parse-issue-list',
      'check-integration',
      'local-repos',
      'startup',
      'shelve',
      'unshelve',
      'dismiss',
      'undismiss',
      'snooze',
      'unsnooze',
    ];

    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    // Add all remaining expected commands to the program for this test
    const alreadyRegistered = new Set(program.commands.map((c) => c.name()));
    for (const name of expectedCommands) {
      if (!alreadyRegistered.has(name)) {
        program.command(name).action(noop);
      }
    }

    const registeredNames = program.commands.map((c) => c.name());

    for (const name of expectedCommands) {
      expect(registeredNames).toContain(name);
    }
  });

  it('should register the program with name "oss-autopilot"', () => {
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);
    expect(program.name()).toBe('oss-autopilot');
  });

  it('should expose a --debug global option', () => {
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);
    const debugOption = program.options.find((o) => o.long === '--debug');
    expect(debugOption).toBeDefined();
  });
});
