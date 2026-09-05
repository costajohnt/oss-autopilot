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
  toCompactDailyOutput: vi.fn((data: unknown) => ({ compacted: data })),
  toCompactStartupOutput: vi.fn((data: unknown) => ({ compacted: data })),
  // Schemas referenced by command actions — exported as opaque markers; the
  // mocked outputJsonValidated above doesn't actually validate. Each marker
  // carries its own name so a deep-equality assertion can tell them apart.
  StatusOutputSchema: { name: 'StatusOutputSchema' },
  SearchOutputSchema: { name: 'SearchOutputSchema' },
  DailyOutputSchema: { name: 'DailyOutputSchema' },
  CompactDailyOutputSchema: { name: 'CompactDailyOutputSchema' },
  DoctorOutputSchema: { name: 'DoctorOutputSchema' },
  SkipAddOutputSchema: { name: 'SkipAddOutputSchema' },
  ListMoveTierOutputSchema: { name: 'ListMoveTierOutputSchema' },
  ListMarkDoneOutputSchema: { name: 'ListMarkDoneOutputSchema' },
  PostOutputSchema: { name: 'PostOutputSchema' },
  ClaimOutputSchema: { name: 'ClaimOutputSchema' },
  InitOutputSchema: { name: 'InitOutputSchema' },
  CheckSetupOutputSchema: { name: 'CheckSetupOutputSchema' },
  SetupOutputSchema: { name: 'SetupOutputSchema' },
  ConfigCommandOutputSchema: { name: 'ConfigCommandOutputSchema' },
  MoveOutputSchema: { name: 'MoveOutputSchema' },
  VerifyIssueOutputSchema: { name: 'VerifyIssueOutputSchema' },
  PRTemplateOutputSchema: { name: 'PRTemplateOutputSchema' },
  ParseIssueListOutputSchema: { name: 'ParseIssueListOutputSchema' },
  CheckIntegrationOutputSchema: { name: 'CheckIntegrationOutputSchema' },
  DetectFormattersOutputSchema: { name: 'DetectFormattersOutputSchema' },
  LocalReposOutputSchema: { name: 'LocalReposOutputSchema' },
  ManifestOutputSchema: { name: 'ManifestOutputSchema' },
  StrategyOutputSchema: { name: 'StrategyOutputSchema' },
  ComplianceScoreOutputSchema: { name: 'ComplianceScoreOutputSchema' },
  FeaturesOutputSchema: { name: 'FeaturesOutputSchema' },
  RepoVetOutputSchema: { name: 'RepoVetOutputSchema' },
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

const mockRunStatus = vi.fn();
vi.mock('./commands/status.js', () => ({ runStatus: mockRunStatus }));

const mockRunStrategy = vi.fn();
vi.mock('./commands/strategy.js', () => ({ runStrategy: mockRunStrategy }));

const mockRunDaily = vi.fn();
const mockRunDailyForDisplay = vi.fn();
const mockPrintDigest = vi.fn();
vi.mock('./commands/daily.js', () => ({
  runDaily: mockRunDaily,
  runDailyForDisplay: mockRunDailyForDisplay,
  printDigest: mockPrintDigest,
}));

const mockRunTrack = vi.fn();
vi.mock('./commands/track.js', () => ({ runTrack: mockRunTrack }));

const mockRunComplianceScore = vi.fn();
vi.mock('./commands/compliance-score.js', () => ({ runComplianceScore: mockRunComplianceScore }));

const mockRunComments = vi.fn();
const mockRunPost = vi.fn();
const mockRunClaim = vi.fn();
vi.mock('./commands/comments.js', () => ({
  runComments: mockRunComments,
  runPost: mockRunPost,
  runClaim: mockRunClaim,
}));

const mockRunStateShow = vi.fn();
const mockRunStateSync = vi.fn();
const mockRunStateUnlink = vi.fn();
vi.mock('./commands/state-cmd.js', () => ({
  runStateShow: mockRunStateShow,
  runStateSync: mockRunStateSync,
  runStateUnlink: mockRunStateUnlink,
}));

const mockRunFeatures = vi.fn();
vi.mock('./commands/features.js', () => ({ runFeatures: mockRunFeatures, MAX_FEATURES_RESULTS: 50 }));

const mockRunVet = vi.fn();
vi.mock('./commands/vet.js', () => ({ runVet: mockRunVet }));

const mockRunVetList = vi.fn();
vi.mock('./commands/vet-list.js', () => ({ runVetList: mockRunVetList }));

const mockRunListMoveTier = vi.fn();
vi.mock('./commands/list-move-tier.js', () => ({ runListMoveTier: mockRunListMoveTier }));

const mockRunMarkDone = vi.fn();
vi.mock('./commands/list-mark-done.js', () => ({ runMarkIssueListItemDone: mockRunMarkDone }));

const mockRunConfig = vi.fn();
vi.mock('./commands/config.js', () => ({ runConfig: mockRunConfig }));

const mockRunInit = vi.fn();
vi.mock('./commands/init.js', () => ({ runInit: mockRunInit }));

const mockRunSetup = vi.fn();
const mockRunCheckSetup = vi.fn();
vi.mock('./commands/setup.js', () => ({ runSetup: mockRunSetup, runCheckSetup: mockRunCheckSetup }));

const mockRunParseList = vi.fn();
vi.mock('./commands/parse-list.js', () => ({ runParseList: mockRunParseList }));

const mockRunCheckIntegration = vi.fn();
vi.mock('./commands/check-integration.js', () => ({ runCheckIntegration: mockRunCheckIntegration }));

const mockRunDoctor = vi.fn();
vi.mock('./commands/doctor.js', () => ({ runDoctor: mockRunDoctor }));

const mockRunStartup = vi.fn();
vi.mock('./commands/startup.js', () => ({ runStartup: mockRunStartup }));

const mockRunPRTemplate = vi.fn();
vi.mock('./commands/pr-template.js', () => ({ runPRTemplate: mockRunPRTemplate }));

const mockRunRepoVet = vi.fn();
vi.mock('./commands/repo-vet.js', () => ({ runRepoVet: mockRunRepoVet }));

const mockRunDetectFormatters = vi.fn();
vi.mock('./commands/detect-formatters.js', () => ({ runDetectFormatters: mockRunDetectFormatters }));

const mockRunStats = vi.fn();
vi.mock('./commands/stats.js', () => ({
  runStats: mockRunStats,
  formatStatsMarkdown: vi.fn(() => '# md report'),
  formatStatsBadge: vi.fn(() => ({ schemaVersion: 1, label: 'merged', message: '3' })),
}));

const mockRunOvernight = vi.fn();
const mockRunOvernightRecord = vi.fn();
const mockRunOvernightSchedule = vi.fn();
vi.mock('./commands/overnight.js', () => ({
  runOvernight: mockRunOvernight,
  runOvernightRecord: mockRunOvernightRecord,
  runOvernightSchedule: mockRunOvernightSchedule,
}));

const mockGuidelinesList = vi.fn();
const mockGuidelinesView = vi.fn();
const mockGuidelinesStore = vi.fn();
const mockGuidelinesReset = vi.fn();
const mockFetchCorpus = vi.fn();
vi.mock('./commands/guidelines.js', () => ({
  runGuidelinesList: mockGuidelinesList,
  runGuidelinesView: mockGuidelinesView,
  runGuidelinesStore: mockGuidelinesStore,
  runGuidelinesReset: mockGuidelinesReset,
  runFetchCorpus: mockFetchCorpus,
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import { commands } from './cli-registry.js';
import {
  outputJson,
  outputJsonError,
  outputJsonValidated,
  CheckIntegrationOutputSchema,
  CheckSetupOutputSchema,
  ConfigCommandOutputSchema,
  DetectFormattersOutputSchema,
  DoctorOutputSchema,
  FeaturesOutputSchema,
  InitOutputSchema,
  ListMarkDoneOutputSchema,
  MoveOutputSchema,
  ParseIssueListOutputSchema,
  PRTemplateOutputSchema,
  RepoVetOutputSchema,
  SetupOutputSchema,
} from './formatters/json.js';

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

/**
 * Run `fn` with process.stdin replaced: a TTY (no data) when `text` is null,
 * otherwise a piped stream yielding `text`. Spies on the getter so Node's
 * real descriptor is restored afterwards.
 */
async function withStdin<T>(text: string | null, fn: () => Promise<T>): Promise<T> {
  const fake = {
    isTTY: text === null,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text ?? '');
    },
  };
  const spy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(fake as unknown as typeof process.stdin);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
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

describe('search empty-result display', () => {
  const empty = { candidates: [], excludedRepos: [], aiPolicyBlocklist: [], hiddenOwnPRCount: 0 };

  it('prints the no-match note, or the rate-limit warning when present', async () => {
    mockRunSearch.mockResolvedValueOnce(empty);
    await buildProgram('search').parseAsync(['node', 'cli', 'search']);
    expect(consoleLogSpy).toHaveBeenCalledWith('No matching issues found.');

    mockRunSearch.mockResolvedValueOnce({ ...empty, rateLimitWarning: 'rate limited' });
    await buildProgram('search').parseAsync(['node', 'cli', 'search']);
    expect(consoleWarnSpy).toHaveBeenCalledWith('\nrate limited\n');
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

// ─── status command display/json branching (#1586) ─────────────────────────

describe('status command', () => {
  const statusData = {
    stats: { mergedPRs: 12, closedPRs: 3, mergeRate: '80%', needsResponse: 2 },
    offline: false,
    lastRunAt: '2026-07-24T00:00:00Z',
  };

  /** Concatenate everything written via console.log for content assertions. */
  const logged = () => consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

  it('routes --json through outputJsonValidated with the schema', async () => {
    mockRunStatus.mockResolvedValue(statusData);
    const program = buildProgram('status');

    await program.parseAsync(['node', 'cli', 'status', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), statusData);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('renders stats and lastRunAt in display mode', async () => {
    mockRunStatus.mockResolvedValue(statusData);
    const program = buildProgram('status');

    await program.parseAsync(['node', 'cli', 'status']);

    expect(mockRunStatus).toHaveBeenCalledWith({ offline: undefined });
    const out = logged();
    expect(out).toContain('Merged PRs: 12');
    expect(out).toContain('Merge Rate: 80%');
    expect(out).toContain('Last Run: 2026-07-24T00:00:00Z');
    expect(out).not.toContain('Last Updated:');
  });

  it('renders cache-freshness metadata with --offline', async () => {
    mockRunStatus.mockResolvedValue({ ...statusData, offline: true, lastUpdated: '2026-07-23T00:00:00Z' });
    const program = buildProgram('status');

    await program.parseAsync(['node', 'cli', 'status', '--offline']);

    expect(mockRunStatus).toHaveBeenCalledWith({ offline: true });
    const out = logged();
    expect(out).toContain('Last Updated: 2026-07-23T00:00:00Z');
    expect(out).toContain('no GitHub API calls');
  });

  it('falls back to "Never" when lastRunAt is absent', async () => {
    mockRunStatus.mockResolvedValue({ ...statusData, lastRunAt: undefined });
    const program = buildProgram('status');

    await program.parseAsync(['node', 'cli', 'status']);

    expect(logged()).toContain('Last Run: Never');
  });
});

// ─── strategy command display/json branching (#1586) ───────────────────────

describe('strategy command', () => {
  const logged = () => consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

  const fullStrategy = {
    strategy: {
      profile: {
        style: 'bug-fixer',
        totalPRs: 20,
        mergedCount: 15,
        mergeRate: 0.75,
        primaryLanguages: ['TypeScript', 'Ruby'],
        favoriteRepos: ['org/repo'],
      },
      capacity: {
        openPRCount: 4,
        dormantPRCount: 2,
        dormantRepoCount: 1,
        overExtended: true,
        suggestedAction: 'nudge dormant PRs',
      },
      patterns: {
        trajectoryDirection: 'improving',
        prTypeDistribution: { fix: 10, feat: 5, docs: 0 },
      },
      recommendations: { avoidPatterns: ['large refactors'] },
    },
  };

  it('routes --json through outputJsonValidated', async () => {
    mockRunStrategy.mockResolvedValue(fullStrategy);
    const program = buildProgram('strategy');

    await program.parseAsync(['node', 'cli', 'strategy', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), fullStrategy);
  });

  it('prints the fallback message when strategy is null', async () => {
    mockRunStrategy.mockResolvedValue({ strategy: null, message: 'Not enough tracked PRs.' });
    const program = buildProgram('strategy');

    await program.parseAsync(['node', 'cli', 'strategy']);

    expect(logged()).toContain('Not enough tracked PRs.');
    expect(logged()).not.toContain('Profile:');
  });

  it('renders profile, capacity, trajectory, and recommendations in display mode', async () => {
    mockRunStrategy.mockResolvedValue(fullStrategy);
    const program = buildProgram('strategy');

    await program.parseAsync(['node', 'cli', 'strategy']);

    const out = logged();
    expect(out).toContain('Profile: bug-fixer');
    expect(out).toContain('20 PRs tracked, 15 merged (75% merge rate).');
    expect(out).toContain('Top languages: TypeScript, Ruby');
    expect(out).toContain('Top repos: org/repo');
    expect(out).toContain('Capacity: 4 open, 2 dormant across 1 repo(s).');
    expect(out).toContain('Overextended — suggested action: nudge dormant PRs.');
    expect(out).toContain('Trajectory: improving');
    // Zero-count PR types are filtered from the distribution line.
    expect(out).toContain('PR types (recent): fix=10, feat=5');
    expect(out).not.toContain('docs=0');
    expect(out).toContain('Watch for: large refactors');
  });
});

// ─── daily command branching (#1586) ────────────────────────────────────────

describe('daily command', () => {
  it('routes --json through outputJsonValidated with the full payload', async () => {
    const data = { prs: [], summary: { total: 0 } };
    mockRunDaily.mockResolvedValue(data);
    const program = buildProgram('daily');

    await program.parseAsync(['node', 'cli', 'daily', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), data);
    expect(mockRunDailyForDisplay).not.toHaveBeenCalled();
  });

  it('routes --json --compact through toCompactDailyOutput', async () => {
    const data = { prs: [], summary: { total: 0 } };
    mockRunDaily.mockResolvedValue(data);
    const program = buildProgram('daily');

    await program.parseAsync(['node', 'cli', 'daily', '--json', '--compact']);

    // The mocked toCompactDailyOutput wraps the payload; the wrapped shape
    // must be what reaches outputJsonValidated.
    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), { compacted: data });
  });

  it('prints the digest via printDigest in display mode', async () => {
    const digest = { needsResponse: [] };
    const capacity = { openPRCount: 1 };
    const commentedIssues = [{ url: ISSUE_URL }];
    mockRunDailyForDisplay.mockResolvedValue({ digest, capacity, commentedIssues });
    const program = buildProgram('daily');

    await program.parseAsync(['node', 'cli', 'daily']);

    expect(mockRunDaily).not.toHaveBeenCalled();
    expect(mockPrintDigest).toHaveBeenCalledWith(digest, capacity, commentedIssues);
  });

  it('routes errors through handleCommandError in JSON mode', async () => {
    mockRunDaily.mockRejectedValue(new Error('rate limited'));
    const program = buildProgram('daily');

    await expect(program.parseAsync(['node', 'cli', 'daily', '--json'])).rejects.toThrow('process.exit called');

    expect(mockOutputJsonError).toHaveBeenCalledWith('rate limited', 'UNKNOWN');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

// ─── track command (#1586) ──────────────────────────────────────────────────

describe('track command', () => {
  const trackData = { pr: { repo: 'org/repo', number: 1, title: 'Fix bug' } };

  it('routes --json through outputJson (tier-2, no schema)', async () => {
    mockRunTrack.mockResolvedValue(trackData);
    const program = buildProgram('track');

    await program.parseAsync(['node', 'cli', 'track', PR_URL, '--json']);

    expect(mockRunTrack).toHaveBeenCalledWith({ prUrl: PR_URL });
    expect(mockOutputJson).toHaveBeenCalledWith(trackData);
  });

  it('prints PR metadata and the not-persisted note in display mode', async () => {
    mockRunTrack.mockResolvedValue(trackData);
    const program = buildProgram('track');

    await program.parseAsync(['node', 'cli', 'track', PR_URL]);

    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain('PR: org/repo#1 - Fix bug');
    expect(out).toContain('Nothing is persisted locally.');
  });
});

// ─── compliance-score command (#1586) ───────────────────────────────────────

describe('compliance-score command', () => {
  const scoreData = {
    emoji: '🟢',
    pr: { repo: 'org/repo', number: 7, title: 'Add docs' },
    score: 85,
    rating: 'very_good',
    checks: {
      description: { status: 'pass', weight: 30, detail: 'has description' },
      tests: { status: 'warn', weight: 40, detail: 'partial coverage' },
      size: { status: 'fail', weight: 30, detail: 'too large' },
    },
  };

  it('routes --json through outputJsonValidated', async () => {
    mockRunComplianceScore.mockResolvedValue(scoreData);
    const program = buildProgram('compliance-score');

    await program.parseAsync(['node', 'cli', 'compliance-score', PR_URL, '--json']);

    expect(mockRunComplianceScore).toHaveBeenCalledWith({ prUrl: PR_URL });
    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), scoreData);
  });

  it('renders the score line and one status-tagged line per check', async () => {
    mockRunComplianceScore.mockResolvedValue(scoreData);
    const program = buildProgram('compliance-score');

    await program.parseAsync(['node', 'cli', 'compliance-score', PR_URL]);

    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain('PR org/repo#7: Add docs');
    // rating underscores become spaces
    expect(out).toContain('Score: 85/100 — very good');
    expect(out).toContain('[OK ] description (30%) — has description');
    expect(out).toContain('[WARN] tests (40%) — partial coverage');
    expect(out).toContain('[FAIL] size (30%) — too large');
  });
});

// ─── comments / post / claim commands (#1586) ───────────────────────────────

describe('comments command', () => {
  const logged = () => consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

  const basePR = {
    title: 'Fix flaky test',
    state: 'open',
    mergeable: true,
    head: 'fix/flaky',
    base: 'main',
    url: PR_URL,
  };
  const emptyComments = {
    pr: basePR,
    reviews: [],
    reviewComments: [],
    issueComments: [],
    summary: { reviewCount: 0, inlineCommentCount: 0, discussionCommentCount: 0 },
  };

  it('routes --json through outputJson (tier-2, no schema)', async () => {
    mockRunComments.mockResolvedValue(emptyComments);
    const program = buildProgram('comments');

    await program.parseAsync(['node', 'cli', 'comments', PR_URL, '--json']);

    expect(mockRunComments).toHaveBeenCalledWith({ prUrl: PR_URL, showBots: undefined });
    expect(mockOutputJson).toHaveBeenCalledWith(emptyComments);
  });

  it('passes --bots through to runComments', async () => {
    mockRunComments.mockResolvedValue(emptyComments);
    const program = buildProgram('comments');

    await program.parseAsync(['node', 'cli', 'comments', PR_URL, '--bots', '--json']);

    expect(mockRunComments).toHaveBeenCalledWith({ prUrl: PR_URL, showBots: true });
  });

  it('prints the no-comments fallback when everything is empty', async () => {
    mockRunComments.mockResolvedValue(emptyComments);
    const program = buildProgram('comments');

    await program.parseAsync(['node', 'cli', 'comments', PR_URL]);

    const out = logged();
    expect(out).toContain('## Fix flaky test');
    expect(out).toContain('No comments from other users.');
    expect(out).toContain('**Summary:** 0 reviews, 0 inline comments, 0 discussion comments');
  });

  it('renders reviews, inline comments, and discussion sections', async () => {
    mockRunComments.mockResolvedValue({
      pr: basePR,
      reviews: [
        { state: 'APPROVED', user: 'alice', submittedAt: new Date().toISOString(), body: 'LGTM' },
        { state: 'COMMENTED', user: 'bob', submittedAt: null, body: '' },
      ],
      reviewComments: [
        { user: 'carol', path: 'src/index.ts', createdAt: new Date().toISOString(), body: 'nit: rename' },
      ],
      issueComments: [{ user: 'dave', createdAt: new Date().toISOString(), body: null }],
      summary: { reviewCount: 2, inlineCommentCount: 1, discussionCommentCount: 1 },
    });
    const program = buildProgram('comments');

    await program.parseAsync(['node', 'cli', 'comments', PR_URL]);

    const out = logged();
    expect(out).toContain('### Reviews (newest first)');
    expect(out).toContain('[Approved] **@alice** (APPROVED)');
    // Unknown review states fall back to the [Comment] label.
    expect(out).toContain('[Comment] **@bob** (COMMENTED)');
    expect(out).toContain('> LGTM');
    expect(out).toContain('### Inline Comments (newest first)');
    expect(out).toContain('**@carol** on `src/index.ts`');
    expect(out).toContain('> nit: rename');
    expect(out).toContain('### Discussion (newest first)');
    expect(out).toContain('**@dave**');
    expect(out).not.toContain('No comments from other users.');
    expect(out).toContain('**Summary:** 2 reviews, 1 inline comments, 1 discussion comments');
  });
});

describe('post command', () => {
  it('joins message parts and prints the comment URL', async () => {
    mockRunPost.mockResolvedValue({ commentUrl: `${PR_URL}#issuecomment-1` });
    const program = buildProgram('post');

    await program.parseAsync(['node', 'cli', 'post', PR_URL, 'thanks', 'for', 'the', 'review']);

    expect(mockRunPost).toHaveBeenCalledWith({ url: PR_URL, message: 'thanks for the review' });
    expect(consoleLogSpy).toHaveBeenCalledWith(`Comment posted: ${PR_URL}#issuecomment-1`);
  });

  it('routes --json through outputJsonValidated', async () => {
    const data = { commentUrl: `${PR_URL}#issuecomment-2` };
    mockRunPost.mockResolvedValue(data);
    const program = buildProgram('post');

    await program.parseAsync(['node', 'cli', 'post', PR_URL, 'hi', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(expect.anything(), data);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('--stdin reads and trims the message from stdin, ignoring positional parts', async () => {
    mockRunPost.mockResolvedValue({ commentUrl: `${PR_URL}#issuecomment-5` });

    await withStdin('  from stdin \n', () =>
      buildProgram('post').parseAsync(['node', 'cli', 'post', PR_URL, 'ignored', '--stdin']),
    );

    expect(mockRunPost).toHaveBeenCalledWith({ url: PR_URL, message: 'from stdin' });
  });
});

describe('claim command', () => {
  it('passes undefined message when no message parts are given', async () => {
    mockRunClaim.mockResolvedValue({ commentUrl: `${ISSUE_URL}#issuecomment-3` });
    const program = buildProgram('claim');

    await program.parseAsync(['node', 'cli', 'claim', ISSUE_URL]);

    expect(mockRunClaim).toHaveBeenCalledWith({ issueUrl: ISSUE_URL, message: undefined });
    expect(consoleLogSpy).toHaveBeenCalledWith(`Issue claimed: ${ISSUE_URL}#issuecomment-3`);
  });

  it('joins message parts when provided', async () => {
    mockRunClaim.mockResolvedValue({ commentUrl: `${ISSUE_URL}#issuecomment-4` });
    const program = buildProgram('claim');

    await program.parseAsync(['node', 'cli', 'claim', ISSUE_URL, 'I', 'can', 'take', 'this']);

    expect(mockRunClaim).toHaveBeenCalledWith({ issueUrl: ISSUE_URL, message: 'I can take this' });
  });
});

// ─── executeAction: schema validation path (#1586) ──────────────────────────

describe('executeAction schema validation', () => {
  it('routes a schema mismatch through the JSON error envelope', async () => {
    mockRunStatus.mockResolvedValue({ stats: {} });
    // outputJsonValidated is what throws on drift (#1105); executeAction must
    // not swallow it.
    mockOutputJsonValidated.mockImplementationOnce(() => {
      throw new Error('Output validation failed: stats.mergedPRs required');
    });
    const program = buildProgram('status');

    await expect(program.parseAsync(['node', 'cli', 'status', '--json'])).rejects.toThrow('process.exit called');

    expect(mockOutputJsonError).toHaveBeenCalledWith('Output validation failed: stats.mergedPRs required', 'UNKNOWN');
    expect(mockOutputJson).not.toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('routes a display() throw through the text error path', async () => {
    // vet's display dereferences data.issue; a malformed payload throws inside
    // display, which executeAction's catch must still route to exit(1).
    mockRunVet.mockResolvedValue({});
    const program = buildProgram('vet');

    await expect(program.parseAsync(['node', 'cli', 'vet', ISSUE_URL])).rejects.toThrow('process.exit called');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/^Error: /));
    expect(mockOutputJsonError).not.toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

// ─── state command (#1586) ──────────────────────────────────────────────────

describe('state command', () => {
  const logged = () => consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

  it('defaults to --show and passes --validate through', async () => {
    mockRunStateShow.mockResolvedValue({
      persistence: 'gist',
      gistId: 'abc123',
      gistDegraded: true,
      lastRunAt: undefined,
      invalidEntries: [{ kind: 'pr', url: PR_URL, title: 'bad' }],
    });
    const program = buildProgram('state');

    await program.parseAsync(['node', 'cli', 'state', '--validate']);

    expect(mockRunStateShow).toHaveBeenCalledWith({ validate: true });
    const out = logged();
    expect(out).toContain('Persistence: gist');
    expect(out).toContain('Gist ID: abc123');
    expect(out).toContain('Status: DEGRADED (using local cache)');
    expect(out).toContain('Last run: Never');
    expect(out).toContain('Validation: 1 stored PR(s) with invalid URLs:');
    expect(out).toContain(`[pr] ${PR_URL}  bad`);
  });

  it('reports a clean validation pass', async () => {
    mockRunStateShow.mockResolvedValue({ persistence: 'local', lastRunAt: '2026-01-01', invalidEntries: [] });
    const program = buildProgram('state');

    await program.parseAsync(['node', 'cli', 'state', '--show', '--validate']);

    expect(logged()).toContain('Validation: no invalid PR URLs in stored state.');
  });

  it('--sync prints the pushed Gist id, or the not-in-gist-mode note', async () => {
    mockRunStateSync.mockResolvedValueOnce({ pushed: true, gistId: 'g1' });
    await buildProgram('state').parseAsync(['node', 'cli', 'state', '--sync']);
    expect(logged()).toContain('State pushed to Gist g1');

    consoleLogSpy.mockClear();
    mockRunStateSync.mockResolvedValueOnce({ pushed: false });
    await buildProgram('state').parseAsync(['node', 'cli', 'state', '--sync']);
    expect(logged()).toContain('Not in Gist mode. Nothing to sync.');
  });

  it('--unlink prints the local path and the retained previous Gist', async () => {
    mockRunStateUnlink.mockResolvedValue({ localStatePath: '/tmp/state.json', previousGistId: 'g1' });
    const program = buildProgram('state');

    await program.parseAsync(['node', 'cli', 'state', '--unlink']);

    const out = logged();
    expect(out).toContain('State written to /tmp/state.json');
    expect(out).toContain('Previous Gist (g1) was NOT deleted.');
  });

  it('--json routes through outputJson (tier-2, no schema)', async () => {
    const data = { persistence: 'local' };
    mockRunStateShow.mockResolvedValue(data);
    const program = buildProgram('state');

    await program.parseAsync(['node', 'cli', 'state', '--json']);

    expect(mockOutputJson).toHaveBeenCalledWith(data);
    expect(mockOutputJsonValidated).not.toHaveBeenCalled();
  });
});

// ─── features command (#1586) ───────────────────────────────────────────────

describe('features command', () => {
  const logged = () => consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  const candidate = {
    issue: { repo: 'octo/alpha', number: 3, title: 'Add flag', url: 'https://github.com/octo/alpha/issues/3' },
    recommendation: 'approve',
    reasonsToApprove: ['anchor repo'],
    reasonsToSkip: ['large'],
    viabilityScore: 70,
  };
  const empty = { anchorRepos: [], quickWins: [], biggerBets: [] };

  it('defaults maxResults to 10 and routes --json through the schema', async () => {
    mockRunFeatures.mockResolvedValue(empty);
    const program = buildProgram('features');

    await program.parseAsync(['node', 'cli', 'features', '--json']);

    expect(mockRunFeatures).toHaveBeenCalledWith({ maxResults: 10, anchorThreshold: undefined, splitRatio: undefined });
    expect(mockOutputJsonValidated).toHaveBeenCalledWith(FeaturesOutputSchema, empty);
  });

  it('parses count and threshold overrides, capping count at the max', async () => {
    mockRunFeatures.mockResolvedValue(empty);
    const program = buildProgram('features');

    await program.parseAsync(['node', 'cli', 'features', '80', '--anchor-threshold', '5', '--split-ratio', '0.4']);

    expect(consoleWarnSpy).toHaveBeenCalledWith('Capping features to 50 results (requested: 80)');
    expect(mockRunFeatures).toHaveBeenCalledWith({ maxResults: 50, anchorThreshold: 5, splitRatio: 0.4 });
    expect(logged()).toContain('Searching for feature opportunities (max 50)');
  });

  it.each([
    [['abc'], 'Invalid count "abc". Must be a positive integer.'],
    [['--anchor-threshold', '99'], 'Invalid --anchor-threshold "99". Must be an integer in [1, 50].'],
    [['--split-ratio', '2'], 'Invalid --split-ratio "2". Must be a number in [0, 1].'],
  ])('rejects invalid args %j', async (args, message) => {
    const program = buildProgram('features');

    await expect(program.parseAsync(['node', 'cli', 'features', ...args, '--json'])).rejects.toThrow(
      'process.exit called',
    );

    expect(mockOutputJsonError).toHaveBeenCalledWith(message, 'UNKNOWN');
    expect(mockRunFeatures).not.toHaveBeenCalled();
  });

  it('prints the empty-result fallbacks', async () => {
    mockRunFeatures.mockResolvedValueOnce({ ...empty, rateLimitWarning: 'slow down' });
    await buildProgram('features').parseAsync(['node', 'cli', 'features']);
    expect(consoleWarnSpy).toHaveBeenCalledWith('\nslow down\n');

    mockRunFeatures.mockResolvedValueOnce({ ...empty, message: 'Need 3 merged PRs first.' });
    await buildProgram('features').parseAsync(['node', 'cli', 'features']);
    expect(logged()).toContain('Need 3 merged PRs first.');

    mockRunFeatures.mockResolvedValueOnce(empty);
    await buildProgram('features').parseAsync(['node', 'cli', 'features']);
    expect(logged()).toContain('No feature opportunities found.');
  });

  it('renders anchor repos and both buckets', async () => {
    mockRunFeatures.mockResolvedValue({
      anchorRepos: ['octo/alpha'],
      quickWins: [candidate],
      biggerBets: [{ ...candidate, reasonsToApprove: [], reasonsToSkip: [] }],
      rateLimitWarning: 'near limit',
    });
    const program = buildProgram('features');

    await program.parseAsync(['node', 'cli', 'features']);

    const out = logged();
    expect(out).toContain('Anchor repos (1): octo/alpha');
    expect(consoleWarnSpy).toHaveBeenCalledWith('\nnear limit\n');
    expect(out).toContain('Quick wins (1):');
    expect(out).toContain('Bigger bets (1):');
    expect(out).toContain('[APPROVE] octo/alpha#3: Add flag');
    expect(out).toContain('Viability: 70/100');
    expect(out).toContain('Approve: anchor repo');
    expect(out).toContain('Skip: large');
  });
});

// ─── vet / vet-list commands (#1586) ────────────────────────────────────────

describe('vet command', () => {
  it('renders grade and reasons in display mode', async () => {
    mockRunVet.mockResolvedValue({
      issue: { repo: 'octo/alpha', number: 3, title: 'Add flag', url: ISSUE_URL },
      recommendation: 'skip',
      reasonsToApprove: ['small'],
      reasonsToSkip: ['claimed'],
      grade: { score: 4, reason: 'contested' },
    });
    const program = buildProgram('vet');

    await program.parseAsync(['node', 'cli', 'vet', ISSUE_URL]);

    expect(mockRunVet).toHaveBeenCalledWith({ issueUrl: ISSUE_URL });
    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain(`Vetting issue: ${ISSUE_URL}`);
    expect(out).toContain('[SKIP] octo/alpha#3: Add flag');
    expect(out).toContain('Success score: 4/10 (contested)');
    expect(out).toContain('Approve: small');
    expect(out).toContain('Skip: claimed');
  });

  it('--json routes through outputJson (tier-2)', async () => {
    const data = { issue: {}, recommendation: 'approve' };
    mockRunVet.mockResolvedValue(data);

    await buildProgram('vet').parseAsync(['node', 'cli', 'vet', ISSUE_URL, '--json']);

    expect(mockOutputJson).toHaveBeenCalledWith(data);
  });
});

describe('vet-list command', () => {
  const summary = {
    total: 3,
    stillAvailable: 1,
    atRisk: 1,
    claimed: 0,
    ownOpenPr: 0,
    closed: 0,
    hasPR: 0,
    hasStalledPR: 0,
    errors: 1,
  };
  const issue = { repo: 'octo/alpha', number: 1, title: 'T' };

  it('parses --concurrency and --prune and renders per-status annotations', async () => {
    mockRunVetList.mockResolvedValue({
      summary,
      results: [
        { listStatus: 'still_available', issue },
        { listStatus: 'at_risk', issue },
        { listStatus: 'error', issue, errorMessage: 'boom' },
        { listStatus: 'has_stalled_pr', issue },
        { listStatus: 'own_open_pr', issue },
      ],
      pruneResult: { removedCount: 2 },
    });
    const program = buildProgram('vet-list');

    await program.parseAsync(['node', 'cli', 'vet-list', '--path', '/tmp/list.md', '--concurrency', '3', '--prune']);

    expect(mockRunVetList).toHaveBeenCalledWith({ issueListPath: '/tmp/list.md', concurrency: 3, prune: true });
    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain('Re-vetted 3 issues:');
    expect(out).toContain('Still available: 1');
    expect(out).toContain('✅ [still_available] octo/alpha#1: T');
    expect(out).toContain('[at_risk] octo/alpha#1: T (at risk, mention only)');
    expect(out).toContain('❌ [error] octo/alpha#1: T');
    expect(out).toContain('Error: boom');
    expect(out).toContain('(stalled PR, revive opportunity)');
    expect(out).toContain('(you already have an open PR)');
    expect(out).toContain('Pruned 2 items from issue list.');
  });

  it('rejects a non-positive --concurrency', async () => {
    const program = buildProgram('vet-list');

    await expect(program.parseAsync(['node', 'cli', 'vet-list', '--concurrency', '0'])).rejects.toThrow(
      'process.exit called',
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Invalid concurrency "0". Must be a positive integer.');
    expect(mockRunVetList).not.toHaveBeenCalled();
  });

  it('--json routes through outputJson (tier-2)', async () => {
    const data = { summary, results: [] };
    mockRunVetList.mockResolvedValue(data);

    await buildProgram('vet-list').parseAsync(['node', 'cli', 'vet-list', '--json']);

    expect(mockRunVetList).toHaveBeenCalledWith({ issueListPath: undefined, concurrency: undefined, prune: undefined });
    expect(mockOutputJson).toHaveBeenCalledWith(data);
  });
});

// ─── list-move-tier / list-mark-done commands (#1586) ───────────────────────

describe('list-move-tier command', () => {
  const LIST = '/tmp/list.md';

  it('lower-cases the tier and prints the moved line with from/count labels', async () => {
    mockRunListMoveTier.mockResolvedValue({
      moved: true,
      url: ISSUE_URL,
      toTier: 'skip',
      fromTier: 'maybe',
      count: 2,
      filePath: LIST,
    });
    const program = buildProgram('list-move-tier');

    await program.parseAsync(['node', 'cli', 'list-move-tier', ISSUE_URL, '--tier', 'SKIP', '--list-path', LIST]);

    expect(mockRunListMoveTier).toHaveBeenCalledWith({ issueUrl: ISSUE_URL, tier: 'skip', listPath: LIST });
    expect(consoleLogSpy).toHaveBeenCalledWith(`Moved ${ISSUE_URL} to skip (from maybe) × 2`);
    expect(consoleLogSpy).toHaveBeenCalledWith(`  File: ${LIST}`);
  });

  it('prints the no-move line with the reason fallback', async () => {
    mockRunListMoveTier.mockResolvedValue({ moved: false, url: ISSUE_URL, filePath: LIST });

    await buildProgram('list-move-tier').parseAsync([
      'node',
      'cli',
      'list-move-tier',
      ISSUE_URL,
      '--tier',
      'pursue',
      '--list-path',
      LIST,
    ]);

    expect(consoleLogSpy).toHaveBeenCalledWith(`No move: ${ISSUE_URL} — unchanged`);
  });

  it('rejects an unknown tier before calling the command', async () => {
    const program = buildProgram('list-move-tier');

    await expect(
      program.parseAsync([
        'node',
        'cli',
        'list-move-tier',
        ISSUE_URL,
        '--tier',
        'later',
        '--list-path',
        LIST,
        '--json',
      ]),
    ).rejects.toThrow('process.exit called');

    expect(mockOutputJsonError).toHaveBeenCalledWith(
      'Invalid --tier "later". Must be one of: pursue, maybe, skip.',
      'UNKNOWN',
    );
    expect(mockRunListMoveTier).not.toHaveBeenCalled();
  });
});

describe('list-mark-done command', () => {
  const LIST = '/tmp/list.md';
  const args = [
    'node',
    'cli',
    'list-mark-done',
    ISSUE_URL,
    '--pr-url',
    PR_URL,
    '--pr-status',
    'merged',
    '--list-path',
    LIST,
  ];

  it('passes all options through and prints the marked summary', async () => {
    mockRunMarkDone.mockResolvedValue({
      marked: true,
      url: ISSUE_URL,
      repoHeadingStruck: true,
      filePath: LIST,
      remainingUnderRepo: 0,
    });

    await buildProgram('list-mark-done').parseAsync(args);

    expect(mockRunMarkDone).toHaveBeenCalledWith({
      issueUrl: ISSUE_URL,
      prUrl: PR_URL,
      prStatus: 'merged',
      listPath: LIST,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(`Marked ${ISSUE_URL} done (repo heading also struck)`);
    expect(consoleLogSpy).toHaveBeenCalledWith('  Remaining under repo: 0');
  });

  it('prints the idempotent no-mark line', async () => {
    mockRunMarkDone.mockResolvedValue({ marked: false, url: ISSUE_URL, filePath: LIST, reason: 'already done' });

    await buildProgram('list-mark-done').parseAsync(args);

    expect(consoleLogSpy).toHaveBeenCalledWith(`No mark: ${ISSUE_URL} — already done`);
  });

  it('--json routes through outputJsonValidated', async () => {
    const data = { marked: true, url: ISSUE_URL, filePath: LIST, remainingUnderRepo: 1 };
    mockRunMarkDone.mockResolvedValue(data);

    await buildProgram('list-mark-done').parseAsync([...args, '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(ListMarkDoneOutputSchema, data);
  });
});

// ─── config / init / setup / checkSetup commands (#1586) ────────────────────

describe('config command', () => {
  const logged = () => consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

  it('renders the key catalogue with --list-keys', async () => {
    mockRunConfig.mockResolvedValue({
      keys: [
        { key: 'maxActivePRs', settableVia: 'auto', description: 'Cap', valueHint: 'integer' },
        { key: 'languages', settableVia: 'setup', description: 'Langs', valueHint: 'csv' },
      ],
    });

    await buildProgram('config').parseAsync(['node', 'cli', 'config', '--list-keys']);

    expect(mockRunConfig).toHaveBeenCalledWith({ key: undefined, value: undefined, listKeys: true });
    const out = logged();
    expect(out).toContain('Config keys');
    expect(out).toMatch(/maxActivePRs\s+\(auto\)\s+Cap/);
    expect(out).toMatch(/languages\s+\[setup\]\s+Langs/);
    expect(out).toContain('value: integer');
  });

  it('dumps the full config when no key is given', async () => {
    mockRunConfig.mockResolvedValue({ config: { githubUsername: 'octo' } });

    await buildProgram('config').parseAsync(['node', 'cli', 'config']);

    expect(logged()).toContain('"githubUsername": "octo"');
  });

  it('prints the set confirmation for key/value', async () => {
    mockRunConfig.mockResolvedValue({ key: 'maxActivePRs', value: 7 });

    await buildProgram('config').parseAsync(['node', 'cli', 'config', 'maxActivePRs', '7']);

    expect(mockRunConfig).toHaveBeenCalledWith({ key: 'maxActivePRs', value: '7', listKeys: undefined });
    expect(consoleLogSpy).toHaveBeenCalledWith('Set maxActivePRs to: 7');
  });

  it('--json routes through outputJsonValidated', async () => {
    const data = { config: {} };
    mockRunConfig.mockResolvedValue(data);

    await buildProgram('config').parseAsync(['node', 'cli', 'config', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(ConfigCommandOutputSchema, data);
  });
});

describe('init command', () => {
  it('prints the username confirmation and routes --json through the schema', async () => {
    const data = { username: 'octo' };
    mockRunInit.mockResolvedValue(data);

    await buildProgram('init').parseAsync(['node', 'cli', 'init', 'octo']);
    expect(mockRunInit).toHaveBeenCalledWith({ username: 'octo' });
    expect(consoleLogSpy).toHaveBeenCalledWith('\nUsername set to @octo.');

    await buildProgram('init').parseAsync(['node', 'cli', 'init', 'octo', '--json']);
    expect(mockOutputJsonValidated).toHaveBeenCalledWith(InitOutputSchema, data);
  });
});

describe('setup command', () => {
  const logged = () => consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

  it('--set mode prints each setting and warns', async () => {
    mockRunSetup.mockResolvedValue({ success: true, settings: { maxActivePRs: 5 }, warnings: ['ignored: foo'] });

    await buildProgram('setup').parseAsync(['node', 'cli', 'setup', '--set', 'maxActivePRs=5', 'foo=bar']);

    expect(mockRunSetup).toHaveBeenCalledWith({ reset: undefined, set: ['maxActivePRs=5', 'foo=bar'] });
    expect(consoleLogSpy).toHaveBeenCalledWith('✓ maxActivePRs: 5');
    expect(consoleWarnSpy).toHaveBeenCalledWith('ignored: foo');
  });

  it('already-complete mode prints current settings', async () => {
    mockRunSetup.mockResolvedValue({
      setupComplete: true,
      config: {
        githubUsername: '',
        maxActivePRs: 5,
        dormantThresholdDays: 14,
        approachingDormantDays: 10,
        languages: ['ts'],
        labels: ['good first issue'],
      },
    });

    await buildProgram('setup').parseAsync(['node', 'cli', 'setup', '--reset']);

    expect(mockRunSetup).toHaveBeenCalledWith({ reset: true, set: undefined });
    const out = logged();
    expect(out).toContain('Setup already complete!');
    expect(out).toContain('GitHub username:    (not set)');
    expect(out).toContain('Dormant threshold:  14 days');
    expect(out).toContain('Labels:             good first issue');
  });

  it('setup-required mode prints the prompt protocol', async () => {
    mockRunSetup.mockResolvedValue({
      setupRequired: true,
      prompts: [
        { setting: 'githubUsername', prompt: 'Your handle?', current: null, required: true, type: 'string' },
        { setting: 'languages', prompt: 'Langs?', current: ['ts'], default: ['ts', 'go'] },
      ],
    });

    await buildProgram('setup').parseAsync(['node', 'cli', 'setup']);

    const out = logged();
    expect(out).toContain('SETUP_REQUIRED');
    expect(out).toContain('SETTING: githubUsername');
    expect(out).toContain('CURRENT: (not set)');
    expect(out).toContain('REQUIRED: true');
    expect(out).toContain('TYPE: string');
    expect(out).toContain('CURRENT: ts');
    expect(out).toContain('DEFAULT: ts, go');
    expect(out).toContain('END_SETUP_PROMPTS');
  });

  it('--json routes through outputJsonValidated', async () => {
    const data = { setupRequired: true, prompts: [] };
    mockRunSetup.mockResolvedValue(data);

    await buildProgram('setup').parseAsync(['node', 'cli', 'setup', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(SetupOutputSchema, data);
  });
});

describe('checkSetup command', () => {
  it('prints SETUP_COMPLETE with the username, or SETUP_INCOMPLETE', async () => {
    mockRunCheckSetup.mockResolvedValueOnce({ setupComplete: true, username: 'octo' });
    await buildProgram('checkSetup').parseAsync(['node', 'cli', 'checkSetup']);
    expect(consoleLogSpy).toHaveBeenCalledWith('SETUP_COMPLETE');
    expect(consoleLogSpy).toHaveBeenCalledWith('username=octo');

    mockRunCheckSetup.mockResolvedValueOnce({ setupComplete: false });
    await buildProgram('checkSetup').parseAsync(['node', 'cli', 'checkSetup']);
    expect(consoleLogSpy).toHaveBeenCalledWith('SETUP_INCOMPLETE');
  });

  it('--json routes through outputJsonValidated', async () => {
    const data = { setupComplete: false };
    mockRunCheckSetup.mockResolvedValue(data);

    await buildProgram('checkSetup').parseAsync(['node', 'cli', 'checkSetup', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(CheckSetupOutputSchema, data);
  });
});

// ─── parse-issue-list / orphan-files / doctor commands (#1586) ──────────────

describe('parse-issue-list command', () => {
  const item = { tier: 'pursue', repo: 'octo/alpha', number: 1, title: 'T' };

  it('renders available and completed sections with the resolved path', async () => {
    mockRunParseList.mockResolvedValue({
      availableCount: 1,
      completedCount: 1,
      available: [item],
      completed: [{ ...item, tier: 'maybe', number: 2 }],
    });

    await buildProgram('parse-issue-list').parseAsync(['node', 'cli', 'parse-issue-list', '/tmp/list.md']);

    expect(mockRunParseList).toHaveBeenCalledWith({ filePath: '/tmp/list.md' });
    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain('Issue List: /tmp/list.md');
    expect(out).toContain('Available: 1 | Completed: 1');
    expect(out).toContain('--- Available ---');
    expect(out).toContain('[pursue] octo/alpha#1: T');
    expect(out).toContain('--- Completed ---');
    expect(out).toContain('[maybe] octo/alpha#2: T');
  });

  it('--json routes through outputJsonValidated', async () => {
    const data = { availableCount: 0, completedCount: 0, available: [], completed: [] };
    mockRunParseList.mockResolvedValue(data);

    await buildProgram('parse-issue-list').parseAsync(['node', 'cli', 'parse-issue-list', '/tmp/list.md', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(ParseIssueListOutputSchema, data);
  });
});

describe('orphan-files command', () => {
  it('prints the no-new-files note', async () => {
    mockRunCheckIntegration.mockResolvedValue({ newFiles: [], unreferencedCount: 0 });

    await buildProgram('orphan-files').parseAsync(['node', 'cli', 'orphan-files']);

    expect(mockRunCheckIntegration).toHaveBeenCalledWith({ base: 'main' });
    expect(consoleLogSpy).toHaveBeenCalledWith('\nNo new code files to check.');
  });

  it('--json routes through outputJsonValidated', async () => {
    const data = { newFiles: [], unreferencedCount: 0 };
    mockRunCheckIntegration.mockResolvedValue(data);

    await buildProgram('orphan-files').parseAsync(['node', 'cli', 'orphan-files', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(CheckIntegrationOutputSchema, data);
  });

  it('renders integrated and orphaned files under the check-integration alias', async () => {
    mockRunCheckIntegration.mockResolvedValue({
      newFiles: [
        { path: 'src/a.ts', isIntegrated: true, referencedBy: ['src/index.ts'] },
        { path: 'src/b.ts', isIntegrated: false, referencedBy: [], suggestedEntryPoints: ['src/cli.ts'] },
      ],
      unreferencedCount: 1,
    });

    await buildProgram('orphan-files').parseAsync(['node', 'cli', 'check-integration', '--base', 'develop']);

    expect(mockRunCheckIntegration).toHaveBeenCalledWith({ base: 'develop' });
    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain('Integration Check (base: develop)');
    expect(out).toContain('New files: 2 | Unreferenced: 1');
    expect(out).toContain('✅ src/a.ts');
    expect(out).toContain('Referenced by: src/index.ts');
    expect(out).toContain('⚠️ src/b.ts');
    expect(out).toContain('Not referenced by any file');
    expect(out).toContain('Suggested entry points: src/cli.ts');
  });
});

describe('doctor command', () => {
  it('renders one status-tagged line per check plus the summary', async () => {
    mockRunDoctor.mockResolvedValue({
      checks: [
        { name: 'token', status: 'ok', message: 'present' },
        { name: 'bundle', status: 'warning', message: 'stale', remediation: 'pnpm run bundle' },
        { name: 'state', status: 'error', message: 'corrupt' },
      ],
      summary: { ok: 1, warnings: 1, errors: 1 },
    });

    await buildProgram('doctor').parseAsync(['node', 'cli', 'doctor']);

    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain('[OK]   token: present');
    expect(out).toContain('[WARN] bundle: stale');
    expect(out).toContain('↳ pnpm run bundle');
    expect(out).toContain('[ERR]  state: corrupt');
    expect(out).toContain('1 ok / 1 warning / 1 error');
  });

  it('--json routes through outputJsonValidated', async () => {
    const data = { checks: [], summary: { ok: 0, warnings: 0, errors: 0 } };
    mockRunDoctor.mockResolvedValue(data);

    await buildProgram('doctor').parseAsync(['node', 'cli', 'doctor', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(DoctorOutputSchema, data);
  });
});

// ─── startup command (#1586) ────────────────────────────────────────────────

describe('startup command', () => {
  const ready = { setupComplete: true, version: '9.9.9', daily: { briefSummary: '2 PRs need attention' } };

  it('--json emits the full payload; --compact wraps it', async () => {
    mockRunStartup.mockResolvedValue(ready);

    await buildProgram('startup').parseAsync(['node', 'cli', 'startup', '--json']);
    expect(mockOutputJson).toHaveBeenCalledWith(ready);

    await buildProgram('startup').parseAsync(['node', 'cli', 'startup', '--json', '--compact']);
    expect(mockOutputJson).toHaveBeenCalledWith({ compacted: ready });
  });

  it('prints version and brief summary in display mode', async () => {
    mockRunStartup.mockResolvedValue(ready);

    await buildProgram('startup').parseAsync(['node', 'cli', 'startup']);

    expect(consoleLogSpy).toHaveBeenCalledWith('OSS Autopilot v9.9.9');
    expect(consoleLogSpy).toHaveBeenCalledWith('2 PRs need attention');
  });

  it('prints the setup-incomplete and auth-error branches', async () => {
    mockRunStartup.mockResolvedValueOnce({ setupComplete: false });
    await buildProgram('startup').parseAsync(['node', 'cli', 'startup']);
    expect(consoleLogSpy).toHaveBeenCalledWith('Setup incomplete. Run /setup-oss first.');

    mockRunStartup.mockResolvedValueOnce({ setupComplete: true, authError: 'bad token' });
    await buildProgram('startup').parseAsync(['node', 'cli', 'startup']);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: bad token');
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('routes a thrown error through handleCommandError in JSON mode', async () => {
    mockRunStartup.mockRejectedValue(new Error('offline'));

    await expect(buildProgram('startup').parseAsync(['node', 'cli', 'startup', '--json'])).rejects.toThrow(
      'process.exit called',
    );

    expect(mockOutputJsonError).toHaveBeenCalledWith('offline', 'UNKNOWN');
  });
});

// ─── pr-template / repo-vet / detect-formatters commands (#1586) ────────────

describe('pr-template command', () => {
  it('prints the template, the warning, or the not-found note', async () => {
    mockRunPRTemplate.mockResolvedValueOnce({ template: '## Summary', source: '.github/PULL_REQUEST_TEMPLATE.md' });
    await buildProgram('pr-template').parseAsync(['node', 'cli', 'pr-template', 'octo/alpha']);
    expect(mockRunPRTemplate).toHaveBeenCalledWith({ repo: 'octo/alpha' });
    expect(consoleLogSpy).toHaveBeenCalledWith('\nPR template found at: .github/PULL_REQUEST_TEMPLATE.md\n');
    expect(consoleLogSpy).toHaveBeenCalledWith('## Summary');

    mockRunPRTemplate.mockResolvedValueOnce({ template: null, error: '404' });
    await buildProgram('pr-template').parseAsync(['node', 'cli', 'pr-template', 'octo/alpha']);
    expect(consoleErrorSpy).toHaveBeenCalledWith('\nWarning: Could not check for PR template: 404');

    mockRunPRTemplate.mockResolvedValueOnce({ template: null });
    await buildProgram('pr-template').parseAsync(['node', 'cli', 'pr-template', 'octo/alpha']);
    expect(consoleLogSpy).toHaveBeenCalledWith('\nNo PR template found for this repository.');
  });

  it('--json routes through outputJsonValidated', async () => {
    const data = { template: null };
    mockRunPRTemplate.mockResolvedValue(data);

    await buildProgram('pr-template').parseAsync(['node', 'cli', 'pr-template', 'octo/alpha', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(PRTemplateOutputSchema, data);
  });
});

describe('repo-vet command', () => {
  const base = {
    repoSlug: 'octo/alpha',
    rubricScore: 7.25,
    rubricVerdict: 'recommended',
    repoMeta: { stars: 120, lastPushed: '2026-08-01' },
    prMergeTime: { medianDays: 3.456, sampleSize: 12 },
    mergeRate: { percent: 66.6, merged: 2, opened: 3 },
  };

  it('renders the health line, history score, and 90d metrics', async () => {
    mockRunRepoVet.mockResolvedValue({ ...base, historyScore: 8 });

    await buildProgram('repo-vet').parseAsync(['node', 'cli', 'repo-vet', 'octo/alpha']);

    expect(mockRunRepoVet).toHaveBeenCalledWith({ repo: 'octo/alpha' });
    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain('✅ octo/alpha: health 7.3/10 — recommended');
    expect(out).toContain('History score (your past PRs here): 8/10');
    expect(out).toContain('Stars: 120  Last push: 2026-08-01');
    expect(out).toContain('Median merge time (90d): 3.5 days (12 samples)');
    expect(out).toContain('Merge rate (90d): 67% (2/3)');
  });

  it.each([
    ['proceed_with_caution', '⚠️'],
    ['avoid', '❌'],
  ])('maps verdict %s to %s and omits null metrics', async (verdict, emoji) => {
    mockRunRepoVet.mockResolvedValue({
      ...base,
      rubricVerdict: verdict,
      prMergeTime: { medianDays: null, sampleSize: 0 },
      mergeRate: { percent: null, merged: 0, opened: 0 },
    });

    await buildProgram('repo-vet').parseAsync(['node', 'cli', 'repo-vet', 'octo/alpha']);

    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain(`${emoji} octo/alpha: health 7.3/10 — ${verdict}`);
    expect(out).not.toContain('History score');
    expect(out).not.toContain('Median merge time');
    expect(out).not.toContain('Merge rate');
  });

  it('--json routes through outputJsonValidated', async () => {
    mockRunRepoVet.mockResolvedValue(base);

    await buildProgram('repo-vet').parseAsync(['node', 'cli', 'repo-vet', 'octo/alpha', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(RepoVetOutputSchema, base);
  });
});

describe('detect-formatters command', () => {
  it('prints the no-formatters note', async () => {
    mockRunDetectFormatters.mockResolvedValue({ formatters: [], packageJsonScripts: [] });

    await buildProgram('detect-formatters').parseAsync(['node', 'cli', 'detect-formatters']);

    expect(mockRunDetectFormatters).toHaveBeenCalledWith({ repoPath: undefined, ciLog: undefined });
    expect(consoleLogSpy).toHaveBeenCalledWith('\nNo formatters detected.');
  });

  it('renders formatters, scripts, and a positive CI diagnosis', async () => {
    mockRunDetectFormatters.mockResolvedValue({
      formatters: [
        { name: 'prettier', configPath: '.prettierrc', fixCommand: 'prettier -w .', checkCommand: 'prettier -c .' },
      ],
      packageJsonScripts: [{ name: 'lint', command: 'eslint .' }],
      ciDiagnosis: {
        isFormattingFailure: true,
        formatter: 'prettier',
        fixCommand: 'prettier -w .',
        evidence: ['Code style issues'],
      },
    });

    await buildProgram('detect-formatters').parseAsync([
      'node',
      'cli',
      'detect-formatters',
      '/repo',
      '--ci-log',
      '/tmp/ci.log',
    ]);

    expect(mockRunDetectFormatters).toHaveBeenCalledWith({ repoPath: '/repo', ciLog: '/tmp/ci.log' });
    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain('Detected 1 formatter(s):');
    expect(out).toContain('prettier (.prettierrc)');
    expect(out).toContain('Fix:   prettier -w .');
    expect(out).toContain('Check: prettier -c .');
    expect(out).toContain('lint: eslint .');
    expect(out).toContain('CI Diagnosis: Formatting failure detected (prettier)');
    expect(out).toContain('Evidence: Code style issues');
  });

  it('prints the negative CI diagnosis', async () => {
    mockRunDetectFormatters.mockResolvedValue({
      formatters: [],
      packageJsonScripts: [],
      ciDiagnosis: { isFormattingFailure: false },
    });

    await buildProgram('detect-formatters').parseAsync(['node', 'cli', 'detect-formatters', '--ci-log', '/tmp/ci.log']);

    expect(consoleLogSpy).toHaveBeenCalledWith('CI Diagnosis: No formatting failure detected.');
  });

  it('--json routes through outputJsonValidated', async () => {
    const data = { formatters: [], packageJsonScripts: [] };
    mockRunDetectFormatters.mockResolvedValue(data);

    await buildProgram('detect-formatters').parseAsync(['node', 'cli', 'detect-formatters', '--json']);

    expect(mockOutputJsonValidated).toHaveBeenCalledWith(DetectFormattersOutputSchema, data);
  });
});

// ─── stats command (#1586) ──────────────────────────────────────────────────

describe('stats command', () => {
  const stats = {
    username: 'octo',
    totalMerged: 3,
    totalClosed: 1,
    mergeRateFormatted: '75%',
    activePRs: 2,
    reposContributed: 2,
    topRepos: [{ repo: 'octo/alpha', mergedCount: 2 }],
  };

  it('renders the text report with top repos', async () => {
    mockRunStats.mockResolvedValue(stats);

    await buildProgram('stats').parseAsync(['node', 'cli', 'stats']);

    const out = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(out).toContain('OSS Contribution Stats (@octo)');
    expect(out).toContain('Merged PRs:        3');
    expect(out).toContain('Merge Rate:        75%');
    expect(out).toContain('Top Repos:');
    expect(out).toContain('octo/alpha: 2 merged');
    expect(out).toContain('Use --markdown for a shareable report');
  });

  it('--badge wins over --markdown and --json', async () => {
    mockRunStats.mockResolvedValue(stats);

    await buildProgram('stats').parseAsync(['node', 'cli', 'stats', '--badge', '--markdown', '--json']);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      JSON.stringify({ schemaVersion: 1, label: 'merged', message: '3' }, null, 2),
    );
    expect(mockOutputJson).not.toHaveBeenCalled();
  });

  it('--markdown prints the formatted report; --json routes through outputJson', async () => {
    mockRunStats.mockResolvedValue(stats);

    await buildProgram('stats').parseAsync(['node', 'cli', 'stats', '--markdown']);
    expect(consoleLogSpy).toHaveBeenCalledWith('# md report');

    await buildProgram('stats').parseAsync(['node', 'cli', 'stats', '--json']);
    expect(mockOutputJson).toHaveBeenCalledWith(stats);
  });

  it('routes a thrown error through handleCommandError', async () => {
    mockRunStats.mockRejectedValue(new Error('no state'));

    await expect(buildProgram('stats').parseAsync(['node', 'cli', 'stats'])).rejects.toThrow('process.exit called');

    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: no state');
  });
});

// ─── guidelines subcommands (#1586) ─────────────────────────────────────────

describe('guidelines subcommands', () => {
  const REPO = 'octo/alpha';

  it('list prints the empty note or the repo list', async () => {
    mockGuidelinesList.mockResolvedValueOnce({ count: 0, repos: [], storageMode: 'local-unavailable' });
    await buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'list']);
    expect(consoleLogSpy).toHaveBeenCalledWith('No guidelines stored for any repo (storage: local-unavailable).');

    mockGuidelinesList.mockResolvedValueOnce({ count: 2, repos: ['a/b', 'c/d'], storageMode: 'gist' });
    await buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'list']);
    expect(consoleLogSpy).toHaveBeenCalledWith('2 repo(s) with stored guidelines:');
    expect(consoleLogSpy).toHaveBeenCalledWith('  a/b');
  });

  it('list --json routes through outputJson (tier-2)', async () => {
    const data = { count: 0, repos: [], storageMode: 'gist' };
    mockGuidelinesList.mockResolvedValue(data);

    await buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'list', '--json']);

    expect(mockOutputJson).toHaveBeenCalledWith(data);
  });

  it('view prints the content header or the none-stored note', async () => {
    mockGuidelinesView.mockResolvedValueOnce({ repo: REPO, content: '- be nice', byteSize: 9, storageMode: 'gist' });
    await buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'view', '--repo', REPO]);
    expect(mockGuidelinesView).toHaveBeenCalledWith({ repo: REPO });
    expect(consoleLogSpy).toHaveBeenCalledWith(`# Guidelines for ${REPO} (9 bytes)\n`);
    expect(consoleLogSpy).toHaveBeenCalledWith('- be nice');

    mockGuidelinesView.mockResolvedValueOnce({ repo: REPO, content: null, storageMode: 'local-unavailable' });
    await buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'view', '--repo', REPO]);
    expect(consoleLogSpy).toHaveBeenCalledWith(`No guidelines stored for ${REPO} (storage: local-unavailable).`);
  });

  it('view --json routes through outputJson (tier-2)', async () => {
    const data = { repo: REPO, content: null, storageMode: 'gist' };
    mockGuidelinesView.mockResolvedValue(data);

    await buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'view', '--repo', REPO, '--json']);

    expect(mockOutputJson).toHaveBeenCalledWith(data);
  });

  it('store uses --content inline and prints the byte count', async () => {
    mockGuidelinesStore.mockResolvedValue({ repo: REPO, byteSize: 5 });

    await buildProgram('guidelines').parseAsync([
      'node',
      'cli',
      'guidelines',
      'store',
      '--repo',
      REPO,
      '--content',
      'hello',
    ]);

    expect(mockGuidelinesStore).toHaveBeenCalledWith({ repo: REPO, content: 'hello' });
    expect(consoleLogSpy).toHaveBeenCalledWith(`Stored 5 bytes of guidelines for ${REPO}.`);
  });

  it('store without --content reads the markdown from piped stdin', async () => {
    mockGuidelinesStore.mockResolvedValue({ repo: REPO, byteSize: 6 });
    await withStdin('piped\n', () =>
      buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'store', '--repo', REPO]),
    );

    expect(mockGuidelinesStore).toHaveBeenCalledWith({ repo: REPO, content: 'piped\n' });
  });

  it('store without --content fails clearly on a TTY stdin', async () => {
    await expect(
      withStdin(null, () =>
        buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'store', '--repo', REPO, '--json']),
      ),
    ).rejects.toThrow('process.exit called');

    expect(mockOutputJsonError).toHaveBeenCalledWith(
      'No --content provided and stdin is a TTY. Pipe content or pass --content "...".',
      'UNKNOWN',
    );
    expect(mockGuidelinesStore).not.toHaveBeenCalled();
  });

  it('reset prints the deleted or nothing-to-reset line', async () => {
    mockGuidelinesReset.mockResolvedValueOnce({ repo: REPO, deleted: true });
    await buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'reset', '--repo', REPO]);
    expect(mockGuidelinesReset).toHaveBeenCalledWith({ repo: REPO });
    expect(consoleLogSpy).toHaveBeenCalledWith(`Reset guidelines for ${REPO}.`);

    mockGuidelinesReset.mockResolvedValueOnce({ repo: REPO, deleted: false });
    await buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'reset', '--repo', REPO]);
    expect(consoleLogSpy).toHaveBeenCalledWith(`No guidelines existed for ${REPO}; nothing to reset.`);
  });

  it('fetch-corpus parses --limit, passes --force, and reports skipped PRs', async () => {
    mockFetchCorpus.mockResolvedValue({ repo: REPO, prCount: 3, skipped: 2 });

    await buildProgram('guidelines').parseAsync([
      'node',
      'cli',
      'guidelines',
      'fetch-corpus',
      '--repo',
      REPO,
      '--limit',
      '7',
      '--force',
    ]);

    expect(mockFetchCorpus).toHaveBeenCalledWith({ repo: REPO, limit: 7, forceRefetch: true });
    expect(consoleLogSpy).toHaveBeenCalledWith(`Fetched 3 PR comment bundle(s) for ${REPO}.`);
    expect(consoleLogSpy).toHaveBeenCalledWith('  Skipped 2 PR(s) already processed (use --force to re-fetch).');
  });

  it('fetch-corpus omits the skipped line when nothing was skipped', async () => {
    mockFetchCorpus.mockResolvedValue({ repo: REPO, prCount: 1, skipped: 0 });

    await buildProgram('guidelines').parseAsync(['node', 'cli', 'guidelines', 'fetch-corpus', '--repo', REPO]);

    expect(mockFetchCorpus).toHaveBeenCalledWith({ repo: REPO, limit: undefined, forceRefetch: undefined });
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Skipped'));
  });
});

// ─── overnight (#1574) ──────────────────────────────────────────────────────

describe('overnight subcommands', () => {
  const runData = {
    runAt: '2026-09-05T02:00:00.000Z',
    reportPath: '/r/overnight-2026-09-05.md',
    prepare: [{ url: 'u1', type: 'ci_failing', label: '[CI]', reason: 'red' }],
    judgment: [],
    attention: { needsAttention: 1, stuckCI: 1, dormantFollowup: 0, waiting: 0 },
    failures: [],
    warnings: [],
    carriedPrepared: 0,
  };

  it('run is the default subcommand and prints the report path and counts', async () => {
    mockRunOvernight.mockResolvedValue(runData);

    await buildProgram('overnight').parseAsync(['node', 'cli', 'overnight']);

    expect(mockRunOvernight).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith('Overnight report: /r/overnight-2026-09-05.md');
    expect(consoleLogSpy).toHaveBeenCalledWith('  1 to prepare, 0 need your judgment');
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('carried over'));
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('could not be fetched'));
  });

  it('run prints carry-over, fetch failures, and the gist warning when present', async () => {
    mockRunOvernight.mockResolvedValue({
      ...runData,
      carriedPrepared: 2,
      failures: [{ prUrl: 'u9', error: 'boom' }],
      gistSyncWarning: 'push failed',
    });

    await buildProgram('overnight').parseAsync(['node', 'cli', 'overnight', 'run']);

    expect(consoleLogSpy).toHaveBeenCalledWith('  2 branch(es) carried over from an earlier run today');
    expect(consoleLogSpy).toHaveBeenCalledWith('  1 PR(s) could not be fetched (listed in the report)');
    expect(consoleLogSpy).toHaveBeenCalledWith('  Warning: push failed');
  });

  it('run --json routes through outputJson (tier-2)', async () => {
    mockRunOvernight.mockResolvedValue(runData);

    await buildProgram('overnight').parseAsync(['node', 'cli', 'overnight', 'run', '--json']);

    expect(mockOutputJson).toHaveBeenCalledWith(runData);
  });

  it('record forwards every flag and prints the recreated and gist notes', async () => {
    mockRunOvernightRecord.mockResolvedValueOnce({ reportPath: '/r.md', preparedCount: 1 });
    await buildProgram('overnight').parseAsync([
      'node',
      'cli',
      'overnight',
      'record',
      '--url',
      'u1',
      '--branch',
      'b1',
      '--worktree',
      '/w',
      '--note',
      'fixed lint',
    ]);
    expect(mockRunOvernightRecord).toHaveBeenCalledWith({
      url: 'u1',
      branch: 'b1',
      worktree: '/w',
      note: 'fixed lint',
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('Recorded (1 prepared): /r.md');
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('recreated'));

    mockRunOvernightRecord.mockResolvedValueOnce({
      reportPath: '/r.md',
      preparedCount: 2,
      reportRecreated: true,
      gistSyncWarning: 'push failed',
    });
    await buildProgram('overnight').parseAsync(['node', 'cli', 'overnight', 'record', '--url', 'u2', '--branch', 'b2']);
    expect(mockRunOvernightRecord).toHaveBeenLastCalledWith({
      url: 'u2',
      branch: 'b2',
      worktree: undefined,
      note: undefined,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('recreated with only the prepared section'));
    expect(consoleLogSpy).toHaveBeenCalledWith('  Warning: push failed');
  });

  it('record --json routes through outputJson (tier-2)', async () => {
    const data = { reportPath: '/r.md', preparedCount: 1 };
    mockRunOvernightRecord.mockResolvedValue(data);

    await buildProgram('overnight').parseAsync([
      'node',
      'cli',
      'overnight',
      'record',
      '--url',
      'u',
      '--branch',
      'b',
      '--json',
    ]);

    expect(mockOutputJson).toHaveBeenCalledWith(data);
  });

  it('schedule defaults hour 2 and a bare claude, prints the plist without --install', async () => {
    mockRunOvernightSchedule.mockResolvedValue({
      plist: '<plist/>',
      plistPath: '/p.plist',
      installed: false,
      loadCommand: 'launchctl bootstrap x',
    });

    await buildProgram('overnight').parseAsync(['node', 'cli', 'overnight', 'schedule']);

    expect(mockRunOvernightSchedule).toHaveBeenCalledWith({ hour: 2, claudePath: 'claude', install: false });
    expect(consoleLogSpy).toHaveBeenCalledWith('<plist/>');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nLoad it with:\n  launchctl bootstrap x');
  });

  it('schedule --install with overrides prints the written path instead of the plist', async () => {
    mockRunOvernightSchedule.mockResolvedValue({
      plist: '<plist/>',
      plistPath: '/p.plist',
      installed: true,
      loadCommand: 'launchctl bootstrap x',
    });

    await buildProgram('overnight').parseAsync([
      'node',
      'cli',
      'overnight',
      'schedule',
      '--hour',
      '3',
      '--claude-path',
      '/opt/claude',
      '--install',
    ]);

    expect(mockRunOvernightSchedule).toHaveBeenCalledWith({ hour: 3, claudePath: '/opt/claude', install: true });
    expect(consoleLogSpy).toHaveBeenCalledWith('Wrote /p.plist');
    expect(consoleLogSpy).not.toHaveBeenCalledWith('<plist/>');
  });

  it('schedule --json routes through outputJson (tier-2)', async () => {
    const data = { plist: '<plist/>', plistPath: '/p.plist', installed: false, loadCommand: 'x' };
    mockRunOvernightSchedule.mockResolvedValue(data);

    await buildProgram('overnight').parseAsync(['node', 'cli', 'overnight', 'schedule', '--json']);

    expect(mockOutputJson).toHaveBeenCalledWith(data);
  });

  it('a thrown run error routes through the JSON error envelope and exit(1)', async () => {
    mockRunOvernight.mockRejectedValue(new Error('daily check failed'));

    await expect(buildProgram('overnight').parseAsync(['node', 'cli', 'overnight', 'run', '--json'])).rejects.toThrow(
      'process.exit called',
    );

    expect(mockOutputJsonError).toHaveBeenCalledWith('daily check failed', expect.anything());
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
