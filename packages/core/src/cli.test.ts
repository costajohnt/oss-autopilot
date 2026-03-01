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
import { readFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';

// ─── Mock core imports ───────────────────────────────────────────────────────

vi.mock('./core/index.js', () => ({
  getGitHubTokenAsync: vi.fn(),
  enableDebug: vi.fn(),
  debug: vi.fn(),
}));

import { getGitHubTokenAsync, enableDebug, debug } from './core/index.js';

const mockGetGitHubTokenAsync = vi.mocked(getGitHubTokenAsync);
const mockEnableDebug = vi.mocked(enableDebug);
const mockDebug = vi.mocked(debug);

// ─── LOCAL_ONLY_COMMANDS extracted directly from cli.ts source ───────────────
//
// We read cli.ts at test time to extract the actual LOCAL_ONLY_COMMANDS array
// so tests stay in sync automatically rather than relying on a manually maintained copy.
//
// NOTE: 'help' and 'version' are included in cli.ts's list as a defensive measure,
// but Commander handles those built-ins before preAction ever fires, so they are
// never actually matched. They are tested via the length assertion below.

function extractLocalOnlyCommandsFromSource(): string[] {
  const src = readFileSync(join(__dirname, 'cli.ts'), 'utf-8');
  const match = src.match(/const LOCAL_ONLY_COMMANDS = \[([\s\S]*?)\];/);
  if (!match) throw new Error('Could not locate LOCAL_ONLY_COMMANDS in cli.ts');
  const entries = match[1].match(/'([^']+)'/g);
  if (!entries) throw new Error('Could not parse LOCAL_ONLY_COMMANDS entries from cli.ts');
  return entries.map((s) => s.replace(/'/g, ''));
}

const LOCAL_ONLY_COMMANDS = extractLocalOnlyCommandsFromSource();

// ─── Helper: build a minimal Commander program with the same preAction hook ──

const noop = vi.fn(async () => {});

function buildTestProgram(localOnlyCommands: string[]) {
  const program = new Command();
  program.name('oss-autopilot').option('--debug', 'Enable debug logging');

  // Register a representative set of commands: two that require a token (daily, search)
  // and two that are LOCAL_ONLY (status, config). This is sufficient to exercise
  // preAction hook branching without wiring up all 25 real commands.
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
      const token = await getGitHubTokenAsync();
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
    // 20 entries: 18 active + 'help' and 'version' which Commander intercepts before
    // preAction fires, so they are defensive/dead entries but intentionally kept.
    expect(LOCAL_ONLY_COMMANDS).toHaveLength(20);
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
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    // "status" is in LOCAL_ONLY_COMMANDS — should not call getGitHubTokenAsync
    await program.parseAsync(['node', 'cli', 'status']);

    expect(mockGetGitHubTokenAsync).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should allow "config" to run without a token', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', 'config']);

    expect(mockGetGitHubTokenAsync).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should call process.exit(1) when a non-LOCAL command runs without a token', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await expect(program.parseAsync(['node', 'cli', 'daily'])).rejects.toThrow('process.exit called');

    expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should call process.exit(1) when "search" runs without a token', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await expect(program.parseAsync(['node', 'cli', 'search'])).rejects.toThrow('process.exit called');

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should print a descriptive error message when authentication is missing', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await expect(program.parseAsync(['node', 'cli', 'daily'])).rejects.toThrow('process.exit called');

    const errorOutput = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(errorOutput).toContain('GitHub authentication required');
  });

  it('should allow a non-LOCAL command to run when a token is available', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_valid_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', 'daily']);

    expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should check the token exactly once per non-LOCAL command invocation', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_some_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', 'search']);

    expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
  });

  it('should NOT check the token for LOCAL_ONLY_COMMANDS even when a token exists', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_existing_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', 'status']);

    expect(mockGetGitHubTokenAsync).not.toHaveBeenCalled();
  });

  it('should call enableDebug when --debug flag is passed', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_debug_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', '--debug', 'daily']);

    expect(mockEnableDebug).toHaveBeenCalledTimes(1);
  });

  it('should call debug() with the command name when --debug is set', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_debug_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', '--debug', 'daily']);

    expect(mockDebug).toHaveBeenCalledWith('cli', 'Running command: daily');
  });

  it('should NOT call enableDebug when --debug flag is absent', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_token');
    const program = buildTestProgram(LOCAL_ONLY_COMMANDS);

    await program.parseAsync(['node', 'cli', 'daily']);

    expect(mockEnableDebug).not.toHaveBeenCalled();
    expect(mockDebug).not.toHaveBeenCalled();
  });

  it('should not call process.exit for LOCAL_ONLY_COMMANDS even when --debug is set', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
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
    let version: string;
    try {
      const pkgPath = join(__dirname, '..', 'package.json');
      version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
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
      // Attempt to read a path that does not exist
      version = JSON.parse(readFileSync('/nonexistent/path/package.json', 'utf-8')).version;
      version = 'should-not-reach';
    } catch {
      version = '0.0.0';
    }

    expect(version).toBe('0.0.0');
  });

  it('should fall back to "0.0.0" when package.json contains invalid JSON', () => {
    let version: string;
    try {
      version = JSON.parse('not valid json').version;
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

// Helper: extract command names registered in cli.ts by parsing its source.
//
// In cli.ts, each command is registered via method chaining across two lines:
//   program
//     .command('name')
//     .description(...)
//
// The regex uses the multiline flag and anchors to line-start indentation so it
// matches '.command(' calls without needing 'program' on the same line.
// Arguments like '<pr-url>' and '[count]' are excluded via the character class.
function extractRegisteredCommandsFromSource(): string[] {
  const src = readFileSync(join(__dirname, 'cli.ts'), 'utf-8');
  // Match both `.command('name')` at line start and `program.command('name')` mid-line
  const matches = src.matchAll(/\.command\('([^'\s<[]+)/gm);
  return [...matches].map((m) => m[1]);
}

describe('Command registration', () => {
  it('should register all expected subcommands', () => {
    // Extract command names directly from cli.ts source so this test tracks
    // additions and deletions in the real entry point automatically.
    const registeredInCli = extractRegisteredCommandsFromSource();

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
      'serve',
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

    for (const name of expectedCommands) {
      expect(registeredInCli).toContain(name);
    }

    // Enforce exact count so additions to cli.ts are noticed here too.
    expect(registeredInCli).toHaveLength(expectedCommands.length);
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

// ─── Lazy import verification ─────────────────────────────────────────────────

describe('Lazy imports', () => {
  it('should use dynamic import() in action handlers instead of static imports', () => {
    const src = readFileSync(join(__dirname, 'cli.ts'), 'utf-8');

    // There should be NO static imports from ./commands/*
    const staticCommandImports = src.match(/^import .+ from '\.\/(commands\/[^']+)';$/gm);
    expect(staticCommandImports).toBeNull();

    // There SHOULD be dynamic imports inside action handlers
    const dynamicImports = src.match(/await import\('\.\/(commands\/[^']+)'\)/g);
    expect(dynamicImports).not.toBeNull();
    expect(dynamicImports!.length).toBeGreaterThanOrEqual(20);
  });

  it('should use getGitHubTokenAsync instead of getGitHubToken in preAction hook', () => {
    const src = readFileSync(join(__dirname, 'cli.ts'), 'utf-8');

    // The preAction hook should use the async version
    expect(src).toContain('await getGitHubTokenAsync()');

    // There should be no synchronous getGitHubToken calls (only the async import)
    const syncTokenCalls = src.match(/[^A]getGitHubToken\(\)/g);
    expect(syncTokenCalls).toBeNull();
  });
});
