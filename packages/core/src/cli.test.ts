/**
 * Tests for CLI entry point and command registry
 *
 * Tests the registry pattern (cli-registry.ts) and preAction hook (cli.ts):
 * 1. Validates local-only command membership via the registry's localOnly flags
 * 2. Exercises preAction hook behavior via a minimal Commander replica
 * 3. Verifies version detection IIFE graceful fallback
 * 4. Confirms all expected subcommands are registered in the registry
 * 5. Verifies lazy-loading pattern in cli-registry.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';

// ─── Mock core imports ───────────────────────────────────────────────────────

vi.mock('./core/index.js', () => ({
  getGitHubTokenAsync: vi.fn(),
  enableDebug: vi.fn(),
  debug: vi.fn(),
  getCLIVersion: vi.fn().mockReturnValue('0.0.0-test'),
}));

vi.mock('./core/errors.js', () => ({
  errorMessage: vi.fn((err: unknown) => String(err)),
  resolveErrorCode: vi.fn(() => 'UNKNOWN'),
}));

vi.mock('./formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
}));

import { getGitHubTokenAsync, enableDebug, debug } from './core/index.js';

const mockGetGitHubTokenAsync = vi.mocked(getGitHubTokenAsync);
const mockEnableDebug = vi.mocked(enableDebug);
const mockDebug = vi.mocked(debug);

// ─── Import registry directly ────────────────────────────────────────────────
//
// The registry is the single source of truth for command definitions.
// Tests import it directly instead of parsing source code with regex.

import { commands } from './cli-registry.js';

const LOCAL_ONLY_COMMANDS = commands.filter((c) => c.localOnly).map((c) => c.name);

// ─── Helper: build a minimal Commander program with the same preAction hook ──

async function noop(): Promise<void> {}

function buildTestProgram(localOnlySet: Set<string>) {
  const program = new Command();
  program.name('oss-autopilot').option('--debug', 'Enable debug logging');

  // Register a representative set of commands: two that require a token (daily, search),
  // two that are LOCAL_ONLY (status, config), and one subcommand group with
  // localOnly inheritance (group → leaf) to cover the parent-walk path.
  program.command('daily').description('Run daily check').action(noop);
  program.command('status').description('Show status').action(noop);
  program.command('config').description('Show config').action(noop);
  program.command('search').description('Search').action(noop);
  // `localGroup view` should inherit `localGroup`'s localOnly flag.
  const group = program.command('localGroup').description('Group');
  group.command('view').action(noop);
  group.command('store').action(noop);

  program.hook('preAction', async (thisCommand, actionCommand) => {
    const globalOpts = thisCommand.opts();
    if (globalOpts.debug) {
      enableDebug();
      debug('cli', `Running command: ${actionCommand.name()}`);
    }

    // Walk parent chain so a localOnly group covers all its leaf subcommands
    // (#1208 M2). Mirrors the production preAction in cli.ts.
    let cmd: typeof actionCommand | null = actionCommand;
    let isLocalOnly = false;
    while (cmd) {
      if (localOnlySet.has(cmd.name())) {
        isLocalOnly = true;
        break;
      }
      cmd = cmd.parent;
    }

    if (!isLocalOnly) {
      const token = await getGitHubTokenAsync();
      if (!token) {
        console.error('Error: GitHub authentication required.');
        process.exit(1);
      }
    }
  });

  return program;
}

// Build the Set the same way cli.ts does
const localOnlySet = new Set(LOCAL_ONLY_COMMANDS);

// ─── LOCAL_ONLY_COMMANDS membership ──────────────────────────────────────────

describe('LOCAL_ONLY_COMMANDS (derived from registry)', () => {
  const expectedLocalOnly = [
    'status',
    'strategy',
    'config',
    'setup',
    'checkSetup',
    'serve',
    'parse-issue-list',
    'orphan-files',
    'doctor',
    'detect-formatters',
    'local-repos',
    'startup',
    'shelve',
    'unshelve',
    'move',
    'dismiss',
    'undismiss',
    'override',
    'clear-override',
    'stats',
    'skip-add',
    'list-move-tier',
    'list-mark-done',
    'manifest',
    'guidelines',
  ];

  const expectedTokenRequired = [
    'daily',
    'search',
    'vet',
    'vet-list',
    'track',
    'comments',
    'post',
    'init',
    'claim',
    'pr-template',
    'state',
  ];

  it.each(expectedLocalOnly)('should contain local-only command "%s"', (cmd) => {
    expect(LOCAL_ONLY_COMMANDS).toContain(cmd);
  });

  it.each(expectedTokenRequired)('should NOT contain token-required command "%s"', (cmd) => {
    expect(LOCAL_ONLY_COMMANDS).not.toContain(cmd);
  });

  it('should have exactly the expected number of local-only entries', () => {
    expect(LOCAL_ONLY_COMMANDS).toHaveLength(expectedLocalOnly.length);
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
    const program = buildTestProgram(localOnlySet);

    // "status" is local-only — should not call getGitHubTokenAsync
    await program.parseAsync(['node', 'cli', 'status']);

    expect(mockGetGitHubTokenAsync).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should allow "config" to run without a token', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const program = buildTestProgram(localOnlySet);

    await program.parseAsync(['node', 'cli', 'config']);

    expect(mockGetGitHubTokenAsync).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should call process.exit(1) when a non-LOCAL command runs without a token', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const program = buildTestProgram(localOnlySet);

    await expect(program.parseAsync(['node', 'cli', 'daily'])).rejects.toThrow('process.exit called');

    expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should call process.exit(1) when "search" runs without a token', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const program = buildTestProgram(localOnlySet);

    await expect(program.parseAsync(['node', 'cli', 'search'])).rejects.toThrow('process.exit called');

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("should let a leaf subcommand inherit its parent group's localOnly flag (#1208 M2)", async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    // Mark the group (not the leaf) as localOnly — the parent-walk should
    // pick it up so `localGroup view` skips the auth gate even though
    // `view` itself isn't in the localOnlySet.
    const setWithGroup = new Set([...localOnlySet, 'localGroup']);
    const program = buildTestProgram(setWithGroup);

    await program.parseAsync(['node', 'cli', 'localGroup', 'view']);

    expect(mockGetGitHubTokenAsync).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should still gate leaf subcommands when the parent group is NOT localOnly', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    // Group not in localOnlySet → leaf should still hit the auth gate.
    const program = buildTestProgram(localOnlySet);

    await expect(program.parseAsync(['node', 'cli', 'localGroup', 'view'])).rejects.toThrow('process.exit called');

    expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
  });

  it('should print a descriptive error message when authentication is missing', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const program = buildTestProgram(localOnlySet);

    await expect(program.parseAsync(['node', 'cli', 'daily'])).rejects.toThrow('process.exit called');

    const errorOutput = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(errorOutput).toContain('GitHub authentication required');
  });

  it('should allow a non-LOCAL command to run when a token is available', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_valid_token');
    const program = buildTestProgram(localOnlySet);

    await program.parseAsync(['node', 'cli', 'daily']);

    expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('should check the token exactly once per non-LOCAL command invocation', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_some_token');
    const program = buildTestProgram(localOnlySet);

    await program.parseAsync(['node', 'cli', 'search']);

    expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
  });

  it('should NOT check the token for LOCAL_ONLY_COMMANDS even when a token exists', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_existing_token');
    const program = buildTestProgram(localOnlySet);

    await program.parseAsync(['node', 'cli', 'status']);

    expect(mockGetGitHubTokenAsync).not.toHaveBeenCalled();
  });

  it('should call enableDebug when --debug flag is passed', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_debug_token');
    const program = buildTestProgram(localOnlySet);

    await program.parseAsync(['node', 'cli', '--debug', 'daily']);

    expect(mockEnableDebug).toHaveBeenCalledTimes(1);
  });

  it('should call debug() with the command name when --debug is set', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_debug_token');
    const program = buildTestProgram(localOnlySet);

    await program.parseAsync(['node', 'cli', '--debug', 'daily']);

    expect(mockDebug).toHaveBeenCalledWith('cli', 'Running command: daily');
  });

  it('should NOT call enableDebug when --debug flag is absent', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue('ghp_token');
    const program = buildTestProgram(localOnlySet);

    await program.parseAsync(['node', 'cli', 'daily']);

    expect(mockEnableDebug).not.toHaveBeenCalled();
    expect(mockDebug).not.toHaveBeenCalled();
  });

  it('should not call process.exit for LOCAL_ONLY_COMMANDS even when --debug is set', async () => {
    mockGetGitHubTokenAsync.mockResolvedValue(null);
    const program = buildTestProgram(localOnlySet);

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
      version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
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
      version = JSON.parse(readFileSync('/nonexistent/path/package.json', 'utf8')).version;
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

// ─── Command registration (registry-based) ──────────────────────────────────

describe('Command registration', () => {
  it('should register all expected subcommands in the registry', () => {
    const registeredNames = commands.map((c) => c.name);

    const expectedCommands = [
      'daily',
      'status',
      'strategy',
      'search',
      'features',
      'vet',
      'vet-list',
      'track',
      'compliance-score',
      'comments',
      'post',
      'claim',
      'config',
      'init',
      'setup',
      'checkSetup',
      'serve',
      'parse-issue-list',
      'orphan-files',
      'doctor',
      'detect-formatters',
      'local-repos',
      'startup',
      'shelve',
      'unshelve',
      'move',
      'dismiss',
      'undismiss',
      'pr-template',
      'repo-vet',
      'override',
      'clear-override',
      'stats',
      'state',
      'skip-add',
      'list-move-tier',
      'list-mark-done',
      'guidelines',
      'manifest',
    ];

    for (const name of expectedCommands) {
      expect(registeredNames).toContain(name);
    }

    // Enforce exact count so additions to the registry are noticed here too.
    expect(registeredNames).toHaveLength(expectedCommands.length);
  });

  it('should have a register function on every command definition', () => {
    for (const cmd of commands) {
      expect(typeof cmd.register).toBe('function');
      expect(typeof cmd.name).toBe('string');
      expect(cmd.name.length).toBeGreaterThan(0);
    }
  });

  it('should register the program with name "oss-autopilot"', () => {
    const program = buildTestProgram(localOnlySet);
    expect(program.name()).toBe('oss-autopilot');
  });

  it('should expose a --debug global option', () => {
    const program = buildTestProgram(localOnlySet);
    const debugOption = program.options.find((o) => o.long === '--debug');
    expect(debugOption).toBeDefined();
  });

  it('should successfully register all commands on a Commander program', () => {
    const program = new Command();
    program.name('test-program');

    // Register all commands from the registry
    for (const cmd of commands) {
      cmd.register(program);
    }

    // Verify commands were registered by checking program.commands
    const registeredNames = program.commands.map((c) => c.name());
    expect(registeredNames).toContain('daily');
    expect(registeredNames).toContain('status');
    expect(registeredNames).toContain('dashboard'); // parent of 'serve'
  });
});

// ─── Search maxResults cap ────────────────────────────────────────────────────

describe('Search maxResults cap', () => {
  it('should enforce MAX_SEARCH_RESULTS = 100 via the shared export (#1002)', async () => {
    const searchCmd = commands.find((c) => c.name === 'search');
    expect(searchCmd).toBeDefined();

    // Behavior check: assert the single-source-of-truth constant equals 100.
    const { MAX_SEARCH_RESULTS } = await import('./commands/search.js');
    expect(MAX_SEARCH_RESULTS).toBe(100);
  });

  it('should warn to console when capping maxResults', () => {
    const src = readFileSync(join(__dirname, 'cli-registry.ts'), 'utf8');
    expect(src).toContain('Capping search to');
  });
});

// ─── Lazy import verification ─────────────────────────────────────────────────

describe('Lazy imports', () => {
  it('should use dynamic import() in action handlers instead of static imports', () => {
    // Read cli-registry.ts where command definitions now live
    const src = readFileSync(join(__dirname, 'cli-registry.ts'), 'utf8');

    // There should be NO static imports from ./commands/* or ./core/index.js
    const staticCommandImports = src.match(/^import .+ from '\.\/(commands\/[^']+)';$/gm);
    expect(staticCommandImports).toBeNull();
    const staticCoreBarrelImport = src.match(/^import .+ from '\.\/core\/index\.js';$/gm);
    expect(staticCoreBarrelImport).toBeNull();

    // There SHOULD be dynamic imports inside action handlers
    const dynamicImports = src.match(/await import\('\.\/(commands\/[^']+)'\)/g);
    expect(dynamicImports).not.toBeNull();
    expect(dynamicImports!.length).toBeGreaterThanOrEqual(20);
  });

  it('cli.ts should not have static imports from commands/', () => {
    const src = readFileSync(join(__dirname, 'cli.ts'), 'utf8');

    // cli.ts should import from cli-registry, not from commands/ directly
    const staticCommandImports = src.match(/^import .+ from '\.\/(commands\/[^']+)';$/gm);
    expect(staticCommandImports).toBeNull();
  });

  it('cli.ts should import from cli-registry', () => {
    const src = readFileSync(join(__dirname, 'cli.ts'), 'utf8');
    expect(src).toContain("from './cli-registry.js'");
  });

  it('should use getGitHubTokenAsync in preAction hook', () => {
    const src = readFileSync(join(__dirname, 'cli.ts'), 'utf8');

    // The preAction hook should use the async version
    expect(src).toContain('await getGitHubTokenAsync()');

    // There should be no synchronous getGitHubToken calls (only the async import)
    const syncTokenCalls = src.match(/[^A]getGitHubToken\(\)/g);
    expect(syncTokenCalls).toBeNull();
  });
});

// ─── CLI argument parsing ─────────────────────────────────────────────────────

describe('CLI argument parsing', () => {
  // Build once — all tests are read-only inspections of Commander's option metadata.
  const program = new Command();
  program.name('oss-autopilot');
  for (const cmd of commands) {
    cmd.register(program);
  }

  /** Find a command by name, checking both top-level and one level of nesting (e.g. dashboard > serve). */
  function findCmd(name: string): Command | undefined {
    const topLevel = program.commands.find((c) => c.name() === name);
    if (topLevel) return topLevel;
    for (const parent of program.commands) {
      const nested = parent.commands.find((c) => c.name() === name);
      if (nested) return nested;
    }
    return undefined;
  }

  it('every command should have --json option (except serve and parent groups)', () => {
    const commandNames = commands.map((c) => c.name);

    // Parent command groups (e.g. `guidelines` → `view`/`store`/`reset`) don't
    // expose --json themselves; their subcommands do. Verify each subcommand
    // separately rather than expecting the parent to carry the flag.
    const parentGroups = new Set<string>(['guidelines']);

    for (const name of commandNames) {
      const cmd = findCmd(name);
      expect(cmd, `command "${name}" should be registered`).toBeDefined();

      if (name === 'serve') {
        // serve intentionally lacks --json
        const jsonOpt = cmd!.options.find((o) => o.long === '--json');
        expect(jsonOpt, 'serve should NOT have --json').toBeUndefined();
      } else if (parentGroups.has(name)) {
        // Parent group: every subcommand must have --json instead.
        for (const sub of cmd!.commands) {
          const jsonOpt = sub.options.find((o) => o.long === '--json');
          expect(jsonOpt, `${name} ${sub.name()} should have --json`).toBeDefined();
        }
      } else {
        const jsonOpt = cmd!.options.find((o) => o.long === '--json');
        expect(jsonOpt, `command "${name}" should have --json`).toBeDefined();
      }
    }
  });

  it('search accepts optional [count] argument', () => {
    const cmd = findCmd('search')!;
    expect(cmd).toBeDefined();
    const countArg = cmd.registeredArguments.find((a) => a.name() === 'count');
    expect(countArg, 'search should have a [count] argument').toBeDefined();
    expect(countArg!.required).toBe(false);
  });

  it('vet requires <issue-url> argument', () => {
    const cmd = findCmd('vet')!;
    expect(cmd).toBeDefined();
    const issueUrlArg = cmd.registeredArguments.find((a) => a.name() === 'issue-url');
    expect(issueUrlArg, 'vet should have an <issue-url> argument').toBeDefined();
    expect(issueUrlArg!.required).toBe(true);
  });

  it('status has --offline option', () => {
    const cmd = findCmd('status');
    expect(cmd).toBeDefined();
    const opt = cmd!.options.find((o) => o.long === '--offline');
    expect(opt, 'status should have --offline').toBeDefined();
  });

  it('comments has --bots option', () => {
    const cmd = findCmd('comments');
    expect(cmd).toBeDefined();
    const opt = cmd!.options.find((o) => o.long === '--bots');
    expect(opt, 'comments should have --bots').toBeDefined();
  });

  it('setup has --reset and --set options', () => {
    const cmd = findCmd('setup');
    expect(cmd).toBeDefined();
    const resetOpt = cmd!.options.find((o) => o.long === '--reset');
    expect(resetOpt, 'setup should have --reset').toBeDefined();
    const setOpt = cmd!.options.find((o) => o.long === '--set');
    expect(setOpt, 'setup should have --set').toBeDefined();
  });

  it('dashboard serve has --port and --no-open options', () => {
    const cmd = findCmd('serve');
    expect(cmd, 'serve should be nested under dashboard').toBeDefined();
    const portOpt = cmd!.options.find((o) => o.long === '--port');
    expect(portOpt, 'serve should have --port').toBeDefined();
    const noOpenOpt = cmd!.options.find((o) => o.long === '--no-open');
    expect(noOpenOpt, 'serve should have --no-open').toBeDefined();
  });

  it('stats has --markdown and --badge options', () => {
    const cmd = findCmd('stats');
    expect(cmd).toBeDefined();
    const markdownOpt = cmd!.options.find((o) => o.long === '--markdown');
    expect(markdownOpt, 'stats should have --markdown').toBeDefined();
    const badgeOpt = cmd!.options.find((o) => o.long === '--badge');
    expect(badgeOpt, 'stats should have --badge').toBeDefined();
  });

  it('local-repos has --scan and --paths options', () => {
    const cmd = findCmd('local-repos');
    expect(cmd).toBeDefined();
    const scanOpt = cmd!.options.find((o) => o.long === '--scan');
    expect(scanOpt, 'local-repos should have --scan').toBeDefined();
    const pathsOpt = cmd!.options.find((o) => o.long === '--paths');
    expect(pathsOpt, 'local-repos should have --paths').toBeDefined();
  });

  it('post has --stdin option', () => {
    const cmd = findCmd('post');
    expect(cmd).toBeDefined();
    const opt = cmd!.options.find((o) => o.long === '--stdin');
    expect(opt, 'post should have --stdin').toBeDefined();
  });

  it('serve --port defaults to "3000"', () => {
    const cmd = findCmd('serve');
    expect(cmd).toBeDefined();
    const portOpt = cmd!.options.find((o) => o.long === '--port');
    expect(portOpt).toBeDefined();
    expect(portOpt!.defaultValue).toBe('3000');
  });

  it('orphan-files has --base option defaulting to "main"', () => {
    const cmd = findCmd('orphan-files');
    expect(cmd).toBeDefined();
    const baseOpt = cmd!.options.find((o) => o.long === '--base');
    expect(baseOpt).toBeDefined();
    expect(baseOpt!.defaultValue).toBe('main');
  });
});

// ─── handleCommandError + parseAsync wiring (#1386) ──────────────────────────

describe('handleCommandError (#1386)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never) as unknown as ReturnType<typeof vi.spyOn>;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) as unknown as ReturnType<typeof vi.spyOn>;
    const { outputJsonError } = await import('./formatters/json.js');
    vi.mocked(outputJsonError).mockClear();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('json mode: emits the error envelope with the resolved code and exits 1', async () => {
    const { handleCommandError } = await import('./cli-registry.js');
    const { outputJsonError } = await import('./formatters/json.js');

    expect(() => handleCommandError(new Error('gist corrupt'), true)).toThrow('process.exit called');
    expect(vi.mocked(outputJsonError)).toHaveBeenCalledWith('Error: gist corrupt', 'UNKNOWN');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('text mode: prints the message to stderr and exits 1', async () => {
    const { handleCommandError } = await import('./cli-registry.js');

    expect(() => handleCommandError(new Error('gist corrupt'), false)).toThrow('process.exit called');
    expect(errorSpy).toHaveBeenCalledWith('Error: Error: gist corrupt');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('cli.ts parses asynchronously (#1386)', () => {
  it('uses program.parseAsync() with a handleCommandError catch, not bare parse()', () => {
    // Source pin in the style of the lazy-import checks above: the preAction
    // hook is async, so a synchronous parse() turns hook rejections (corrupt
    // Gist, missing scope, rate limit during bootstrap) into raw
    // UnhandledPromiseRejection stacks instead of actionable messages.
    const source = readFileSync(join(__dirname, 'cli.ts'), 'utf8');
    expect(source).toContain('program.parseAsync()');
    expect(source).toMatch(/parseAsync\(\)\s*\.catch\(/s);
    expect(source).toContain('handleCommandError(err');
    expect(source).not.toMatch(/^program\.parse\(\);/m);
  });
});
