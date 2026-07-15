/**
 * Tests for cli-registry.ts action handler behavior
 *
 * Complements cli.test.ts which covers command registration, local-only flags,
 * preAction hooks, and lazy imports. These tests exercise the
 * inline logic inside each command's .action() callback:
 * - handleCommandError (JSON vs text error output)
 * - Search count validation and capping
 * - Dashboard port validation
 * - Override status validation and mapping
 * - printRepos display formatting
 * - --json vs display output branching
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ─── Mock static imports used by cli-registry.ts ────────────────────────────

vi.mock('./core/errors.js', () => ({
  errorMessage: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
  resolveErrorCode: vi.fn(() => 'UNKNOWN'),
}));

// `manifest` reads getCLIVersion from the barrel export. Stub it so the test
// doesn't pull in the full core/ side effects (state/gist/path modules) that
// other tests in this file already avoid by mocking submodule-level paths.
vi.mock('./core/index.js', () => ({
  getCLIVersion: vi.fn(() => '0.0.0-test'),
}));

vi.mock('./formatters/json.js', () => ({
  outputJson: vi.fn(),
  outputJsonError: vi.fn(),
  outputJsonValidated: vi.fn(),
  // Schemas referenced by command actions — exported as opaque markers; the
  // mocked outputJsonValidated above doesn't actually validate.
  StatusOutputSchema: {},
  SearchOutputSchema: {},
  DailyOutputSchema: {},
  CompactDailyOutputSchema: {},
  DoctorOutputSchema: {},
  SkipAddOutputSchema: {},
  ListMoveTierOutputSchema: {},
  ListMarkDoneOutputSchema: {},
  PostOutputSchema: {},
  ClaimOutputSchema: {},
  InitOutputSchema: {},
  CheckSetupOutputSchema: {},
  SetupOutputSchema: {},
  ConfigCommandOutputSchema: {},
  MoveOutputSchema: {},
  VerifyIssueOutputSchema: {},
  PRTemplateOutputSchema: {},
  ParseIssueListOutputSchema: {},
  CheckIntegrationOutputSchema: {},
  DetectFormattersOutputSchema: {},
  LocalReposOutputSchema: {},
  ManifestOutputSchema: {},
}));

// ─── Mock dynamic command-module imports ────────────────────────────────────

const mockRunSearch = vi.fn();
vi.mock('./commands/search.js', () => ({
  runSearch: mockRunSearch,
  MAX_SEARCH_RESULTS: 100,
  DEFAULT_SEARCH_RESULTS: 15,
  parseSearchStrategies: (raw?: string) => (raw === undefined ? undefined : [raw]),
}));

const mockRunDismiss = vi.fn();
const mockRunUndismiss = vi.fn();
vi.mock('./commands/dismiss.js', () => ({
  runDismiss: mockRunDismiss,
  runUndismiss: mockRunUndismiss,
}));

const mockRunMove = vi.fn();
vi.mock('./commands/move.js', () => ({ runMove: mockRunMove }));

const mockRunLocalRepos = vi.fn();
vi.mock('./commands/local-repos.js', () => ({ runLocalRepos: mockRunLocalRepos }));

const mockServeDashboard = vi.fn();
vi.mock('./commands/dashboard.js', () => ({ serveDashboard: mockServeDashboard }));

const mockRunSkipAdd = vi.fn();
vi.mock('./commands/skip-add.js', () => ({ runSkipAdd: mockRunSkipAdd }));

const mockRunVerifyIssue = vi.fn();
vi.mock('./commands/verify-issue.js', () => ({ runVerifyIssue: mockRunVerifyIssue }));

// ─── Import after mocks ────────────────────────────────────────────────────

import { commands } from './cli-registry.js';
import { outputJson, outputJsonError, outputJsonValidated, MoveOutputSchema } from './formatters/json.js';

const mockOutputJson = vi.mocked(outputJson);
const mockOutputJsonError = vi.mocked(outputJsonError);
const mockOutputJsonValidated = vi.mocked(outputJsonValidated);

// ─── Constants ──────────────────────────────────────────────────────────────

const ISSUE_URL = 'https://github.com/org/repo/issues/1';
const PR_URL = 'https://github.com/org/repo/pull/1';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Register a single command by name on a fresh Commander program. */
function buildProgram(commandName: string): Command {
  const program = new Command();
  program.name('test');
  const def = commands.find((c) => c.name === commandName);
  if (!def) throw new Error(`Unknown command: ${commandName}`);
  def.register(program);
  return program;
}

// ─── Shared setup/teardown ──────────────────────────────────────────────────

let processExitSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as any);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

// ─── handleCommandError ─────────────────────────────────────────────────────

describe('handleCommandError', () => {
  it('should output text error and exit(1) when --json is not set', async () => {
    mockRunDismiss.mockRejectedValue(new Error('network failure'));
    const program = buildProgram('dismiss');

    await expect(program.parseAsync(['node', 'cli', 'dismiss', ISSUE_URL])).rejects.toThrow('process.exit called');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: network failure');
    expect(mockOutputJsonError).not.toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should output JSON error and exit(1) when --json is set', async () => {
    mockRunDismiss.mockRejectedValue(new Error('network failure'));
    const program = buildProgram('dismiss');

    await expect(program.parseAsync(['node', 'cli', 'dismiss', ISSUE_URL, '--json'])).rejects.toThrow(
      'process.exit called',
    );

    expect(mockOutputJsonError).toHaveBeenCalledWith('network failure', 'UNKNOWN');
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(expect.stringContaining('Error:'));
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle non-Error thrown values', async () => {
    mockRunDismiss.mockRejectedValue('string error');
    const program = buildProgram('dismiss');

    await expect(program.parseAsync(['node', 'cli', 'dismiss', ISSUE_URL])).rejects.toThrow('process.exit called');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: string error');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

// ─── Search count validation ────────────────────────────────────────────────

describe('search count validation', () => {
  const emptySearchResult = { candidates: [], excludedRepos: [], aiPolicyBlocklist: [] };

  it('should default to 15 results when no count is provided', async () => {
    mockRunSearch.mockResolvedValue(emptySearchResult);
    const program = buildProgram('search');

    await program.parseAsync(['node', 'cli', 'search', '--json']);

    // 15 leaves headroom past scout's affinity phases (#1571)
    expect(mockRunSearch).toHaveBeenCalledWith({ maxResults: 15 });
    // search routes through outputJsonValidated (#1147); the second arg is the result
    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), emptySearchResult);
  });

  it('should accept a valid positive integer count', async () => {
    mockRunSearch.mockResolvedValue(emptySearchResult);
    const program = buildProgram('search');

    await program.parseAsync(['node', 'cli', 'search', '10', '--json']);

    expect(mockRunSearch).toHaveBeenCalledWith({ maxResults: 10 });
    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), emptySearchResult);
  });

  it.each(['abc', '1.5', '0', '-3'])('should reject invalid count "%s"', async (count) => {
    const program = buildProgram('search');

    await expect(program.parseAsync(['node', 'cli', 'search', count, '--json'])).rejects.toThrow('process.exit called');

    expect(mockOutputJsonError).toHaveBeenCalledWith(
      `Invalid count "${count}". Must be a positive integer.`,
      'UNKNOWN',
    );
    expect(mockRunSearch).not.toHaveBeenCalled();
  });

  it('should cap count at 100 and warn', async () => {
    mockRunSearch.mockResolvedValue(emptySearchResult);
    const program = buildProgram('search');

    await program.parseAsync(['node', 'cli', 'search', '150', '--json']);

    expect(consoleWarnSpy).toHaveBeenCalledWith('Capping search to 100 results (requested: 150)');
    expect(mockRunSearch).toHaveBeenCalledWith({ maxResults: 100 });
    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), emptySearchResult);
  });
});

// ─── Search text-mode display (#1421) ───────────────────────────────────────

describe('search text-mode display', () => {
  it('renders hiddenOwnPRCount, boost reasons, and the diversity-slot annotation', async () => {
    mockRunSearch.mockResolvedValue({
      candidates: [
        {
          issue: {
            repo: 'octo/alpha',
            number: 1,
            title: 'Boosted pick',
            url: 'https://github.com/octo/alpha/issues/1',
            labels: [],
          },
          recommendation: 'approve',
          reasonsToApprove: ['Active maintainers'],
          reasonsToSkip: [],
          viabilityScore: 88,
          boostReasons: ['merged PR history', 'preferred org'],
        },
        {
          issue: {
            repo: 'octo/beta',
            number: 2,
            title: 'Diversity pick',
            url: 'https://github.com/octo/beta/issues/2',
            labels: [],
          },
          recommendation: 'needs_review',
          reasonsToApprove: [],
          reasonsToSkip: ['No prior relationship'],
          viabilityScore: 60,
          diversitySlot: true,
        },
      ],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      hiddenOwnPRCount: 2,
    });
    const program = buildProgram('search');

    await program.parseAsync(['node', 'cli', 'search']);

    const lines = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(lines).toContain('Hidden: 2 candidate(s) were issues you already have open PRs for.');
    expect(lines).toContain('  Why surfaced: merged PR history, preferred org');
    expect(lines).toContain('  Diversity slot: outside your usual languages/repos');
    expect(lines).toContain('Found 2 candidates:\n');
  });
});

// ─── verify-issue text-mode display (#1421) ─────────────────────────────────

describe('verify-issue text-mode display', () => {
  it('renders state, verdict, assignees, and linked-PR annotations', async () => {
    mockRunVerifyIssue.mockResolvedValue({
      owner: 'octo',
      repo: 'hello',
      number: 7,
      title: 'Fix the widget',
      url: 'https://github.com/octo/hello/issues/7',
      state: 'closed',
      stateReason: 'completed',
      closedAt: '2026-06-01T00:00:00Z',
      verdict: 'closed',
      verdictReason: 'Issue is closed (completed)',
      assignees: ['alice'],
      linkedPRs: [
        {
          number: 9,
          state: 'merged',
          isDraft: false,
          linkType: 'closing',
          author: 'bob',
          isOwn: false,
          url: 'https://github.com/octo/hello/pull/9',
        },
        {
          number: 10,
          state: 'open',
          isDraft: true,
          linkType: 'cross-referenced',
          author: null,
          isOwn: true,
          url: 'https://github.com/octo/hello/pull/10',
        },
      ],
    });
    const program = buildProgram('verify-issue');

    await program.parseAsync(['node', 'cli', 'verify-issue', 'https://github.com/octo/hello/issues/7']);

    expect(mockRunVerifyIssue).toHaveBeenCalledWith({ issueUrl: 'https://github.com/octo/hello/issues/7' });
    const lines = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(lines).toContain('\nocto/hello#7: Fix the widget');
    expect(lines).toContain('  State: closed (completed) — closed 2026-06-01T00:00:00Z');
    expect(lines).toContain('  Verdict: closed — Issue is closed (completed)');
    expect(lines).toContain('  Assignees: alice');
    expect(lines).toContain('  PR #9 [merged] closing by bob: https://github.com/octo/hello/pull/9');
    expect(lines).toContain(
      '  PR #10 [open] [draft] cross-referenced by ghost (yours): https://github.com/octo/hello/pull/10',
    );
  });
});

// ─── Dashboard port validation ──────────────────────────────────────────────

describe('dashboard port validation', () => {
  it('should accept a valid port number', async () => {
    const program = buildProgram('serve');

    await program.parseAsync(['node', 'cli', 'dashboard', 'serve', '--port', '8080']);

    expect(mockServeDashboard).toHaveBeenCalledWith({ port: 8080, open: true });
  });

  it.each(['abc', '0', '70000'])('should reject invalid port "%s"', async (port) => {
    const program = buildProgram('serve');

    await expect(program.parseAsync(['node', 'cli', 'dashboard', 'serve', '--port', port])).rejects.toThrow(
      'process.exit called',
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      `Invalid port number: "${port}". Must be an integer between 1 and 65535.`,
    );
    expect(mockServeDashboard).not.toHaveBeenCalled();
  });

  it('should output text error when serveDashboard throws (no --json option)', async () => {
    mockServeDashboard.mockRejectedValue(new Error('EADDRINUSE'));
    const program = buildProgram('serve');

    await expect(program.parseAsync(['node', 'cli', 'dashboard', 'serve'])).rejects.toThrow('process.exit called');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: EADDRINUSE');
    expect(mockOutputJsonError).not.toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

// ─── move schema wiring (#1453) ─────────────────────────────────────────────

describe('move schema wiring (#1453)', () => {
  it('move --json routes through outputJsonValidated with MoveOutputSchema', async () => {
    const payload = {
      url: PR_URL,
      target: 'shelved',
      description: 'Shelved — excluded from capacity and actionable items',
    };
    mockRunMove.mockResolvedValue(payload);
    const program = buildProgram('move');

    await program.parseAsync(['node', 'cli', 'move', PR_URL, 'shelved', '--json']);

    expect(mockRunMove).toHaveBeenCalledWith({ prUrl: PR_URL, target: 'shelved' });
    expect(mockOutputJsonValidated).toHaveBeenCalledTimes(1);
    const [schemaArg, dataArg] = mockOutputJsonValidated.mock.calls[0];
    // Identity check: the registration must pass the exported MoveOutputSchema
    // itself, not just any schema — otherwise the runtime --json validation
    // path (#1105) can never fire for move.
    expect(schemaArg).toBe(MoveOutputSchema);
    expect(dataArg).toEqual(payload);
    expect(mockOutputJson).not.toHaveBeenCalled();
  });

  it('move display mode prints the description without JSON output', async () => {
    mockRunMove.mockResolvedValue({
      url: PR_URL,
      target: 'waiting',
      description: 'Moved to Waiting on Maintainer',
    });
    const program = buildProgram('move');

    await program.parseAsync(['node', 'cli', 'move', PR_URL, 'waiting']);

    expect(consoleLogSpy).toHaveBeenCalledWith('Moved to Waiting on Maintainer');
    expect(mockOutputJson).not.toHaveBeenCalled();
    expect(mockOutputJsonValidated).not.toHaveBeenCalled();
  });
});

// ─── printRepos display formatting ──────────────────────────────────────────

describe('printRepos (via local-repos command)', () => {
  it('should format repos sorted alphabetically with branch info', async () => {
    mockRunLocalRepos.mockResolvedValue({
      repos: {
        'owner/repo-b': { path: '/home/user/repo-b', currentBranch: 'main' },
        'owner/repo-a': { path: '/home/user/repo-a', currentBranch: null },
      },
      scanPaths: ['/home/user'],
      cachedAt: '2024-01-01T00:00:00Z',
      fromCache: false,
    });
    const program = buildProgram('local-repos');

    await program.parseAsync(['node', 'cli', 'local-repos']);

    const logCalls = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]);

    // Verify header
    expect(logCalls).toContain('Found 2 repos:\n');

    // Verify sorted order: repo-a (no branch) before repo-b (with branch)
    expect(logCalls).toContain('  owner/repo-a');
    expect(logCalls).toContain('    /home/user/repo-a');
    expect(logCalls).toContain('  owner/repo-b (main)');
    expect(logCalls).toContain('    /home/user/repo-b');

    // Verify alphabetical sort: repo-a appears before repo-b
    const repoAIndex = logCalls.indexOf('  owner/repo-a');
    const repoBIndex = logCalls.indexOf('  owner/repo-b (main)');
    expect(repoAIndex).toBeLessThan(repoBIndex);
  });

  it('should call outputJsonValidated when --json is passed', async () => {
    const repoData = {
      repos: { 'owner/repo': { path: '/home/user/repo', currentBranch: 'main' } },
      scanPaths: ['/home/user'],
      cachedAt: '2024-01-01T00:00:00Z',
      fromCache: false,
    };
    mockRunLocalRepos.mockResolvedValue(repoData);
    const program = buildProgram('local-repos');

    await program.parseAsync(['node', 'cli', 'local-repos', '--json']);

    // local-repos now routes through outputJsonValidated (#1155)
    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), repoData);
  });

  it('should show cached header when fromCache is true', async () => {
    mockRunLocalRepos.mockResolvedValue({
      repos: { 'owner/repo': { path: '/home/user/repo', currentBranch: 'main' } },
      scanPaths: ['/home/user'],
      cachedAt: '2024-01-01T00:00:00Z',
      fromCache: true,
    });
    const program = buildProgram('local-repos');

    await program.parseAsync(['node', 'cli', 'local-repos']);

    const logCalls = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(logCalls).toContain('\n\ud83d\udcc1 Local Repos (cached 2024-01-01T00:00:00Z)\n');
    expect(logCalls).toContain('  owner/repo (main)');
  });
});

// ─── --json vs display output branching ─────────────────────────────────────

describe('--json vs display output branching', () => {
  it('dismiss --json should call outputJson', async () => {
    mockRunDismiss.mockResolvedValue({ dismissed: true });
    const program = buildProgram('dismiss');

    await program.parseAsync(['node', 'cli', 'dismiss', ISSUE_URL, '--json']);

    expect(mockOutputJson).toHaveBeenCalledWith({ dismissed: true });
  });

  it('dismiss display should show human-readable output', async () => {
    mockRunDismiss.mockResolvedValue({ dismissed: true });
    const program = buildProgram('dismiss');

    await program.parseAsync(['node', 'cli', 'dismiss', ISSUE_URL]);

    expect(mockOutputJson).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(`Dismissed: ${ISSUE_URL}`);
    expect(consoleLogSpy).toHaveBeenCalledWith('Notifications are now muted.');
    expect(consoleLogSpy).toHaveBeenCalledWith('New responses after this point will resurface automatically.');
  });

  it('dismiss display should show "Already dismissed." for no-op', async () => {
    mockRunDismiss.mockResolvedValue({ dismissed: false });
    const program = buildProgram('dismiss');

    await program.parseAsync(['node', 'cli', 'dismiss', ISSUE_URL]);

    expect(consoleLogSpy).toHaveBeenCalledWith('Already dismissed.');
  });

  it('undismiss --json should call outputJson', async () => {
    mockRunUndismiss.mockResolvedValue({ undismissed: true });
    const program = buildProgram('undismiss');

    await program.parseAsync(['node', 'cli', 'undismiss', ISSUE_URL, '--json']);

    expect(mockOutputJson).toHaveBeenCalledWith({ undismissed: true });
  });

  it('undismiss display should show success message', async () => {
    mockRunUndismiss.mockResolvedValue({ undismissed: true });
    const program = buildProgram('undismiss');

    await program.parseAsync(['node', 'cli', 'undismiss', ISSUE_URL]);

    expect(consoleLogSpy).toHaveBeenCalledWith(`Undismissed: ${ISSUE_URL}`);
    expect(consoleLogSpy).toHaveBeenCalledWith('Notifications are active again.');
  });

  it('undismiss display should show "Was not dismissed." for no-op', async () => {
    mockRunUndismiss.mockResolvedValue({ undismissed: false });
    const program = buildProgram('undismiss');

    await program.parseAsync(['node', 'cli', 'undismiss', ISSUE_URL]);

    expect(consoleLogSpy).toHaveBeenCalledWith('Was not dismissed.');
  });
});

// ─── skip-add action ────────────────────────────────────────────────────────

describe('skip-add action', () => {
  const SKIP_FILE = '/tmp/test-skip.md';

  it('prints "Added to skip list" on successful new append', async () => {
    mockRunSkipAdd.mockReturnValue({
      added: true,
      alreadyPresent: false,
      url: ISSUE_URL,
      path: SKIP_FILE,
      date: '2026-04-19',
    });
    const program = buildProgram('skip-add');

    await program.parseAsync(['node', 'cli', 'skip-add', ISSUE_URL]);

    expect(mockRunSkipAdd).toHaveBeenCalledWith({ issueUrl: ISSUE_URL, skipFilePath: undefined });
    expect(consoleLogSpy).toHaveBeenCalledWith(`Added to skip list: ${ISSUE_URL} (2026-04-19)`);
    expect(consoleLogSpy).toHaveBeenCalledWith(`  File: ${SKIP_FILE}`);
    expect(mockOutputJson).not.toHaveBeenCalled();
  });

  it('prints "Already on skip list" when URL is already present', async () => {
    mockRunSkipAdd.mockReturnValue({
      added: false,
      alreadyPresent: true,
      url: ISSUE_URL,
      path: SKIP_FILE,
    });
    const program = buildProgram('skip-add');

    await program.parseAsync(['node', 'cli', 'skip-add', ISSUE_URL]);

    expect(consoleLogSpy).toHaveBeenCalledWith(`Already on skip list: ${ISSUE_URL}`);
    expect(consoleLogSpy).toHaveBeenCalledWith(`  File: ${SKIP_FILE}`);
  });

  it('emits JSON and skips text output when --json is set', async () => {
    const payload = {
      added: true,
      alreadyPresent: false,
      url: ISSUE_URL,
      path: SKIP_FILE,
      date: '2026-04-19',
    };
    mockRunSkipAdd.mockReturnValue(payload);
    const program = buildProgram('skip-add');

    await program.parseAsync(['node', 'cli', 'skip-add', ISSUE_URL, '--json']);

    // skip-add now routes through outputJsonValidated (#1148)
    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), payload);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('passes --path through to runSkipAdd', async () => {
    mockRunSkipAdd.mockReturnValue({
      added: true,
      alreadyPresent: false,
      url: ISSUE_URL,
      path: SKIP_FILE,
      date: '2026-04-19',
    });
    const program = buildProgram('skip-add');

    await program.parseAsync(['node', 'cli', 'skip-add', ISSUE_URL, '--path', SKIP_FILE]);

    expect(mockRunSkipAdd).toHaveBeenCalledWith({ issueUrl: ISSUE_URL, skipFilePath: SKIP_FILE });
  });

  it('routes errors through handleCommandError (text mode)', async () => {
    mockRunSkipAdd.mockImplementation(() => {
      throw new Error('bad url');
    });
    const program = buildProgram('skip-add');

    await expect(program.parseAsync(['node', 'cli', 'skip-add', 'bogus'])).rejects.toThrow('process.exit called');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: bad url');
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(mockOutputJsonError).not.toHaveBeenCalled();
  });

  it('routes errors through handleCommandError (JSON mode)', async () => {
    mockRunSkipAdd.mockImplementation(() => {
      throw new Error('bad url');
    });
    const program = buildProgram('skip-add');

    await expect(program.parseAsync(['node', 'cli', 'skip-add', 'bogus', '--json'])).rejects.toThrow(
      'process.exit called',
    );

    expect(mockOutputJsonError).toHaveBeenCalledWith('bad url', 'UNKNOWN');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

// ─── manifest command (#1190) ───────────────────────────────────────────────

describe('manifest command (#1190)', () => {
  it('produces a payload matching the contract shape', async () => {
    const program = buildProgram('manifest');

    await program.parseAsync(['node', 'cli', 'manifest', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledTimes(1);
    const [, payload] = mockOutputJsonValidated.mock.calls[0];
    expect(payload).toMatchObject({
      schemaVersion: 1,
      cliVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
      commands: expect.any(Array),
    });
    const commandsField = (payload as { commands: Array<{ name: string; localOnly: boolean }> }).commands;
    // Every entry has only the two declared keys.
    for (const entry of commandsField) {
      expect(Object.keys(entry).sort()).toEqual(['localOnly', 'name']);
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.localOnly).toBe('boolean');
    }
    // Commands list matches the registry length and includes 'manifest' itself.
    expect(commandsField.length).toBe(commands.length);
    expect(commandsField.map((c) => c.name)).toContain('manifest');
  });

  it('returns commands sorted alphabetically for stable diffing', async () => {
    const program = buildProgram('manifest');

    await program.parseAsync(['node', 'cli', 'manifest', '--json']);

    const [, payload] = mockOutputJsonValidated.mock.calls[0];
    const names = (payload as { commands: Array<{ name: string }> }).commands.map((c) => c.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('prints a one-liner summary in display mode', async () => {
    const program = buildProgram('manifest');

    await program.parseAsync(['node', 'cli', 'manifest']);

    expect(mockOutputJsonValidated).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^oss-autopilot v\S+ \(\d+ commands\)$/));
  });
});
