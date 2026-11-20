/**
 * Tests for vet command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockVetIssue = vi.fn();
const mockGetRepoScore = vi.fn();
const mockRecordPickSnapshots = vi.fn();
const mockGetState = vi.fn();
const mockFetchVerification = vi.fn();
const mockSetRepoPolicy = vi.fn();
/** The Octokit vet reads the PR template and README-linked docs with (#2013); `{}` makes those reads fail. */
const mockOctokit: { value: unknown } = { value: {} };
const mockFetchPRTemplate = vi.fn();

vi.mock('./scout-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('./scout-bridge.js')>('./scout-bridge.js');
  return {
    ...actual,
    createAutopilotScout: vi.fn(async () => ({
      vetIssue: mockVetIssue,
    })),
  };
});

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    fetchIssueVerification: (...args: unknown[]) => mockFetchVerification(...args),
    getOctokit: () => mockOctokit.value,
    requireGitHubToken: () => 'fake-token',
    getStateManager: () => ({
      getRepoScore: mockGetRepoScore,
      getState: mockGetState,
      recordPickSnapshots: mockRecordPickSnapshots,
      setRepoPolicy: mockSetRepoPolicy,
      isGistMode: () => false,
      reloadIfChanged: () => false,
    }),
  };
});

// Contents arrive as plain text in these stubs: no base64 round trip to maintain.
vi.mock('../core/pr-template.js', () => ({
  decodeBase64: (content: string) => content,
  fetchPRTemplate: () => mockFetchPRTemplate(),
}));

import { runVet } from './vet.js';

const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/5';

function policyCandidate(rawContent?: string) {
  return {
    issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: [] },
    recommendation: 'approve' as const,
    reasonsToApprove: [],
    reasonsToSkip: [],
    projectHealth: {},
    vettingResult: rawContent ? { contributionGuidelines: { rawContent } } : {},
    antiLLMPolicy: { matched: false, matchedKeywords: [], sourceFile: null },
  };
}

/** A contents-API file response; decodeBase64 is mocked to pass text through. */
function fileResponse(text: string) {
  return { data: { type: 'file', content: text } };
}

describe('runVet: PR template and README-linked docs (#2013)', () => {
  const notFound = Object.assign(new Error('Not Found'), { status: 404 });
  let getContent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchVerification.mockRejectedValue(new Error('offline'));
    mockGetRepoScore.mockReturnValue(undefined);
    mockGetState.mockReturnValue({ config: {} });
    mockVetIssue.mockResolvedValue(policyCandidate('Thanks for contributing.'));
    mockFetchPRTemplate.mockResolvedValue({
      template: '- [ ] I comment on the issue and get assigned before opening a PR',
      source: '.github/pull_request_template.md',
    });
    const files = new Map([['docs/ai-policy.md', 'Please keep to one AI-assisted PR at a time.']]);
    getContent = vi.fn(({ path }: { path: string }) => {
      const text = files.get(path);
      return text === undefined ? Promise.reject(notFound) : Promise.resolve(fileResponse(text));
    });
    const readme = [
      '[guide](docs/ai-policy.md) [same](CONTRIBUTING.md) [other](https://github.com/else/where/blob/main/docs/contributing.md)',
      '[escape](../CONTRIBUTING-outside.md) [site](https://example.com/contributing.md)',
    ].join('\n');
    mockOctokit.value = {
      repos: { getContent, getReadme: vi.fn().mockResolvedValue(fileResponse(readme)) },
    };
  });

  afterEach(() => {
    mockOctokit.value = {};
  });

  it('reads the PR template and a same-repo doc the README links to, and records what they say', async () => {
    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(result.policy).toMatchObject({ prGate: 'claim-first', maxOpenAiPRs: 1, reviewedByUser: false });
    expect(mockSetRepoPolicy).toHaveBeenCalledWith(
      'owner/repo',
      expect.objectContaining({ prGate: 'claim-first', maxOpenAiPRs: 1 }),
    );
    // Only the linked same-repo doc is read: not the other repo's, the other site's, or CONTRIBUTING.md again.
    expect(getContent.mock.calls.map(([arg]) => (arg as { path: string }).path)).toEqual(['docs/ai-policy.md']);
  });

  it('still vets, from scout alone, when those reads fail', async () => {
    mockFetchPRTemplate.mockRejectedValue(new Error('rate limited'));
    mockVetIssue.mockResolvedValue(policyCandidate('Comment on the issue and get assigned before opening a PR.'));

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(result.policy).toMatchObject({ prGate: 'claim-first' });
  });
});

describe('runVet: repo contribution policy (#1953)', () => {
  const BAN = 'We do not accept AI-generated contributions.';
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchVerification.mockRejectedValue(new Error('offline'));
    mockGetRepoScore.mockReturnValue(undefined);
  });

  it('records what it read, unreviewed, and a ban makes the issue a skip', async () => {
    mockGetState.mockReturnValue({ config: {} });
    mockVetIssue.mockResolvedValue(policyCandidate(BAN));

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(mockSetRepoPolicy).toHaveBeenCalledWith(
      'owner/repo',
      expect.objectContaining({ aiPolicy: 'banned', reviewedByUser: false }),
    );
    expect(result.policy).toMatchObject({ aiPolicy: 'banned', reviewedByUser: false });
    expect(result.recommendation).toBe('skip');
    expect(result.reasonsToSkip).toContain(
      'repo policy: the project does not accept AI-assisted contributions (read from the repo docs, not reviewed: ' +
        'run `oss-autopilot policy set --repo owner/repo --ai-policy allowed` if this is a misreading)',
    );
  });

  it('does not overwrite a record the user set, and reports that record', async () => {
    const reviewed = {
      aiPolicy: 'allowed',
      cla: 'none',
      commitRules: [],
      prGate: 'none',
      source: [],
      reviewedByUser: true,
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    mockGetState.mockReturnValue({ config: {}, repoPolicies: { 'owner/repo': reviewed } });
    mockVetIssue.mockResolvedValue(policyCandidate(BAN));

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(mockSetRepoPolicy).not.toHaveBeenCalled();
    expect(result.policy).toMatchObject({ aiPolicy: 'allowed', reviewedByUser: true });
    expect(result.recommendation).not.toBe('skip');
  });

  it('with a scout match, keeps one ban reason and adds only how to lift the unreviewed ban', async () => {
    mockGetState.mockReturnValue({ config: {} });
    mockVetIssue.mockResolvedValue({
      ...policyCandidate(BAN),
      recommendation: 'skip' as const,
      reasonsToSkip: ['anti-LLM policy'],
      antiLLMPolicy: { matched: true, matchedKeywords: ['no AI-generated'], sourceFile: 'CONTRIBUTING.md' },
    });

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(result.reasonsToSkip).toEqual([
      'anti-LLM policy',
      'repo policy (read from the repo docs, not reviewed: run `oss-autopilot policy set --repo owner/repo ' +
        '--ai-policy allowed` if this is a misreading)',
    ]);
    expect(result.reasonsToSkip.filter((r) => r.includes('does not accept'))).toHaveLength(0);
  });

  it('records nothing when scout returned no anti-LLM scan result', async () => {
    mockGetState.mockReturnValue({ config: {} });
    mockVetIssue.mockResolvedValue({ ...policyCandidate(BAN), antiLLMPolicy: undefined });

    await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(mockSetRepoPolicy).not.toHaveBeenCalled();
  });

  it('keeps a stored unreviewed ban when a later reading finds none, and still says skip', async () => {
    const ban = {
      aiPolicy: 'banned',
      cla: 'none',
      commitRules: [],
      prGate: 'none',
      source: [],
      reviewedByUser: false,
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    mockGetState.mockReturnValue({ config: {}, repoPolicies: { 'owner/repo': ban } });
    mockVetIssue.mockResolvedValue(policyCandidate('Run npm test before opening a pull request.'));

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(mockSetRepoPolicy).not.toHaveBeenCalled();
    expect(result.policy).toMatchObject({ aiPolicy: 'banned', reviewedByUser: false });
    expect(result.recommendation).toBe('skip');
  });

  it('shows a blocklisted repo as banned even when vet read nothing', async () => {
    mockGetState.mockReturnValue({ config: { aiPolicyBlocklist: ['owner/repo'] } });
    mockVetIssue.mockResolvedValue(policyCandidate());

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(mockSetRepoPolicy).not.toHaveBeenCalled();
    expect(result.policy?.aiPolicy).toBe('banned');
    expect(result.recommendation).toBe('skip');
  });
});

describe('runVet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({ config: { githubUsername: 'costajohnt' } });
    mockFetchVerification.mockRejectedValue(new Error('offline'));
  });

  it('marks the result with repoCap when the repo is at its open-PR cap', async () => {
    mockGetState.mockReturnValue({
      config: { githubUsername: 'costajohnt', maxOpenPRsPerRepo: 2, maxOpenPRsColdRepo: 1, excludeRepos: [] },
      lastDigest: { openPRs: [{ repo: 'owner/repo' }] },
    });
    mockVetIssue.mockResolvedValue({
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: [] },
      recommendation: 'approve' as const,
      reasonsToApprove: [],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    });
    mockGetRepoScore.mockReturnValue(undefined);

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(result.repoCap).toMatchObject({ repo: 'owner/repo', openPRCount: 1, cap: 1, cold: true, atCap: true });
  });

  it('should vet an issue and return structured result', async () => {
    const candidate = {
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: ['bug'] },
      recommendation: 'approve' as const,
      reasonsToApprove: ['Active maintainers', 'Good first issue label'],
      reasonsToSkip: [],
      projectHealth: { avgIssueResponseDays: 2, daysSinceLastCommit: 1 },
      vettingResult: { isViable: true },
    };
    mockVetIssue.mockResolvedValue(candidate);
    mockGetRepoScore.mockReturnValue({ mergedPRCount: 17, closedWithoutMergeCount: 3 });

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(mockVetIssue).toHaveBeenCalledWith(TEST_ISSUE_URL);
    expect(mockGetRepoScore).toHaveBeenCalledWith('owner/repo');
    expect(result).toEqual({
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: ['bug'] },
      recommendation: 'approve',
      reasonsToApprove: ['Active maintainers', 'Good first issue label'],
      reasonsToSkip: [],
      projectHealth: { avgIssueResponseDays: 2, daysSinceLastCommit: 1 },
      vettingResult: { isViable: true },
      antiLLMPolicy: undefined,
      linkedPRClassification: 'none',
      slmTriage: null,
      grade: { score: 10, reason: expect.stringMatching(/respons|merge|commit/i) },
    });
  });

  it('passes complexityUnlocked through from scout and omits the key otherwise', async () => {
    const candidate = {
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: ['bug'] },
      recommendation: 'approve' as const,
      reasonsToApprove: [],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    };
    mockVetIssue.mockResolvedValue({ ...candidate, complexityUnlocked: true });
    const unlocked = await runVet({ issueUrl: TEST_ISSUE_URL });
    expect(unlocked.complexityUnlocked).toBe(true);

    mockVetIssue.mockResolvedValue({ ...candidate, complexityUnlocked: false });
    expect('complexityUnlocked' in (await runVet({ issueUrl: TEST_ISSUE_URL }))).toBe(false);

    mockVetIssue.mockResolvedValue(candidate);
    expect('complexityUnlocked' in (await runVet({ issueUrl: TEST_ISSUE_URL }))).toBe(false);
  });

  it('records the vet-time prediction for calibration (#1824)', async () => {
    mockVetIssue.mockResolvedValue({
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: [] },
      recommendation: 'approve' as const,
      reasonsToApprove: [],
      reasonsToSkip: [],
      projectHealth: { avgIssueResponseDays: 1, daysSinceLastCommit: 1, stargazersCount: 1200 },
      vettingResult: {},
    });
    mockGetRepoScore.mockReturnValue(undefined);

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(mockRecordPickSnapshots).toHaveBeenCalledWith([
      {
        issueUrl: TEST_ISSUE_URL,
        grade: result.grade.score,
        recommendation: result.recommendation,
        stargazersCount: 1200,
        source: 'vet',
        capturedAt: expect.any(String),
        labels: [],
        competingPRs: 0,
        firstInRepo: true,
      },
    ]);
  });

  it('takes pick traits from one verification call, and skips the pick on a ruled-out verdict', async () => {
    mockVetIssue.mockResolvedValue({
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: [] },
      recommendation: 'approve' as const,
      reasonsToApprove: [],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    });
    mockGetRepoScore.mockReturnValue(undefined);
    const otherPR = {
      url: 'https://github.com/owner/repo/pull/6',
      state: 'open',
      isOwn: false,
      isDraft: false,
      linkType: 'closing',
    };
    mockFetchVerification.mockResolvedValue({
      owner: 'owner',
      repo: 'repo',
      verdict: 'at-risk',
      linkedPRs: [otherPR],
      authorAssociation: 'OWNER',
      authorIsBot: false,
      commentCount: 2,
    });

    await runVet({ issueUrl: TEST_ISSUE_URL });
    expect(mockFetchVerification).toHaveBeenCalledWith(expect.anything(), { owner: 'owner', repo: 'repo', number: 5 });
    expect(mockRecordPickSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({
        issueAuthorAssociation: 'OWNER',
        issueAuthorIsBot: false,
        commentCount: 2,
        competingPRs: 1,
      }),
    ]);

    // Same rule as vet-list: closed, taken and own-PR issues record no pick.
    for (const verdict of ['closed', 'taken', 'own-open-pr']) {
      mockRecordPickSnapshots.mockClear();
      mockFetchVerification.mockResolvedValue({ verdict, owner: 'owner', repo: 'repo', linkedPRs: [] });
      await runVet({ issueUrl: TEST_ISSUE_URL });
      expect(mockRecordPickSnapshots).not.toHaveBeenCalled();
    }
  });

  it('includes grade with unknown merge rate when no repo score exists', async () => {
    const candidate = {
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: [] },
      recommendation: 'approve' as const,
      reasonsToApprove: [],
      reasonsToSkip: [],
      projectHealth: { avgIssueResponseDays: 1, daysSinceLastCommit: 1 },
      vettingResult: {},
    };
    mockVetIssue.mockResolvedValue(candidate);
    mockGetRepoScore.mockReturnValue(undefined);

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    // Two 10 signals + one unknown → dropped one band to 7
    expect(result.grade.score).toBe(7);
    expect(result.grade.reason).toMatch(/unknown/i);
  });

  it('should reject a non-GitHub issue URL', async () => {
    await expect(runVet({ issueUrl: 'https://example.com/not-github' })).rejects.toThrow('Invalid issue URL');
  });

  it('should reject a PR URL (not an issue URL)', async () => {
    await expect(runVet({ issueUrl: 'https://github.com/owner/repo/pull/5' })).rejects.toThrow('Invalid issue URL');
  });

  it('should reject a URL that exceeds maximum length', async () => {
    const longUrl = 'https://github.com/' + 'a'.repeat(2100);

    await expect(runVet({ issueUrl: longUrl })).rejects.toThrow('exceeds maximum length');
  });

  it('should propagate errors from vetIssue', async () => {
    mockVetIssue.mockRejectedValue(new Error('Issue not found'));

    await expect(runVet({ issueUrl: TEST_ISSUE_URL })).rejects.toThrow('Issue not found');
  });
});

function isoFromNow(offsetMs: number): string {
  const at = new Date(Date.now() + offsetMs);
  return at.toISOString();
}

describe('runVet — work claims (#1856)', () => {
  it('skips an issue a session is already implementing, names the session, and records no pick', async () => {
    const workClaim = {
      kind: 'implementation',
      url: TEST_ISSUE_URL,
      session: 'air/1200',
      startedAt: isoFromNow(-30 * 60_000),
      expiresAt: isoFromNow(3_600_000),
      status: 'running',
      worktree: '/work/wt/a',
    };
    mockGetState.mockReturnValue({ config: { githubUsername: 'costajohnt' }, workClaims: [workClaim] });
    mockVetIssue.mockResolvedValue({
      issue: { repo: 'owner/repo', number: 5, title: 'Fix bug', url: TEST_ISSUE_URL, labels: [] },
      recommendation: 'approve' as const,
      reasonsToApprove: ['Active maintainers'],
      reasonsToSkip: [],
      projectHealth: {},
      vettingResult: {},
    });
    mockGetRepoScore.mockReturnValue(undefined);

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });

    expect(result.recommendation).toBe('skip');
    expect(result.reasonsToSkip).toEqual([
      'Already being implemented: implementation claimed in session air/1200 (30 min, running)',
    ]);
    expect(result.workClaim).toEqual(workClaim);
    expect(result.reasonsToApprove).toEqual(['Active maintainers']);
    expect(mockRecordPickSnapshots).not.toHaveBeenCalled();
  });
});
