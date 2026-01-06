/**
 * Issue Discovery - Finds and vets potential issues to work on
 * Checks for existing PRs, claims, project health, and contribution guidelines
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { getStateManager } from './state.js';
import { parseGitHubUrl, daysBetween } from './utils.js';
import {
  TrackedIssue,
  IssueVettingResult,
  ContributionGuidelines,
  ProjectHealth,
} from './types.js';

// Concurrency limit for parallel API calls
const MAX_CONCURRENT_REQUESTS = 5;

export interface IssueCandidate {
  issue: TrackedIssue;
  vettingResult: IssueVettingResult;
  projectHealth: ProjectHealth;
  recommendation: 'approve' | 'skip' | 'needs_review';
  reasonsToSkip: string[];
  reasonsToApprove: string[];
}

// Cache for contribution guidelines (expires after 1 hour, max 100 entries)
const guidelinesCache = new Map<string, { guidelines: ContributionGuidelines | undefined; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_SIZE = 100;

function pruneCache(): void {
  if (guidelinesCache.size <= CACHE_MAX_SIZE) return;

  // Remove oldest entries first
  const entries = Array.from(guidelinesCache.entries())
    .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);

  const toRemove = entries.slice(0, guidelinesCache.size - CACHE_MAX_SIZE);
  for (const [key] of toRemove) {
    guidelinesCache.delete(key);
  }
}

export class IssueDiscovery {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;

  constructor(githubToken: string) {
    this.octokit = getOctokit(githubToken);
    this.stateManager = getStateManager();
  }

  /**
   * Search for issues matching our criteria
   */
  async searchIssues(options: {
    languages?: string[];
    labels?: string[];
    maxResults?: number;
  } = {}): Promise<IssueCandidate[]> {
    const config = this.stateManager.getState().config;
    const languages = options.languages || config.languages;
    const labels = options.labels || config.labels;
    const maxResults = options.maxResults || 10;

    const candidates: IssueCandidate[] = [];

    // Build search query
    const labelQuery = labels.map(l => `label:"${l}"`).join(' ');
    const langQuery = languages.map(l => `language:${l}`).join(' ');

    const query = `is:issue is:open ${labelQuery} ${langQuery} no:assignee`;

    console.log(`Searching issues with query: ${query}`);

    try {
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: query,
        sort: 'created',
        order: 'desc',
        per_page: maxResults * 2, // Fetch extra since some will be filtered
      });

      console.log(`Found ${data.total_count} issues, processing top ${data.items.length}...`);

      // Filter items first (fast, no API calls)
      const trackedUrls = new Set(this.stateManager.getState().activeIssues.map(i => i.url));
      const excludedRepos = new Set(config.excludeRepos);

      const itemsToVet = data.items.filter(item => {
        if (trackedUrls.has(item.html_url)) return false;
        const repoFullName = item.repository_url.split('/').slice(-2).join('/');
        if (excludedRepos.has(repoFullName)) return false;
        return true;
      }).slice(0, maxResults * 2); // Get extra in case some fail

      // Vet issues in parallel with concurrency limit
      const results = await this.vetIssuesParallel(itemsToVet.map(i => i.html_url), maxResults);
      candidates.push(...results);
    } catch (error) {
      console.error('Error searching issues:', error);
    }

    // Sort by recommendation
    candidates.sort((a, b) => {
      const order = { approve: 0, needs_review: 1, skip: 2 };
      return order[a.recommendation] - order[b.recommendation];
    });

    return candidates;
  }

  /**
   * Vet multiple issues in parallel with concurrency limit
   */
  private async vetIssuesParallel(urls: string[], maxResults: number): Promise<IssueCandidate[]> {
    const candidates: IssueCandidate[] = [];
    const pending: Promise<void>[] = [];

    for (const url of urls) {
      if (candidates.length >= maxResults) break;

      const task = this.vetIssue(url)
        .then(candidate => {
          if (candidates.length < maxResults) {
            candidates.push(candidate);
          }
        })
        .catch(error => {
          console.error(`Error vetting issue ${url}:`, error instanceof Error ? error.message : error);
        });

      pending.push(task);

      // Limit concurrency
      if (pending.length >= MAX_CONCURRENT_REQUESTS) {
        await Promise.race(pending);
        // Remove completed promises
        const stillPending = pending.filter(p => {
          let resolved = false;
          p.then(() => { resolved = true; }).catch(() => { resolved = true; });
          return !resolved;
        });
        pending.length = 0;
        pending.push(...stillPending);
      }
    }

    // Wait for remaining
    await Promise.allSettled(pending);
    return candidates.slice(0, maxResults);
  }

  /**
   * Vet a specific issue
   */
  async vetIssue(issueUrl: string): Promise<IssueCandidate> {
    // Parse URL
    const parsed = parseGitHubUrl(issueUrl);
    if (!parsed || parsed.type !== 'issues') {
      throw new Error(`Invalid issue URL: ${issueUrl}`);
    }

    const { owner, repo, number } = parsed;
    const repoFullName = `${owner}/${repo}`;

    // Fetch issue data
    const { data: ghIssue } = await this.octokit.issues.get({
      owner,
      repo,
      issue_number: number,
    });

    // Run all vetting checks in parallel
    const [noExistingPR, notClaimed, projectHealth, contributionGuidelines] = await Promise.all([
      this.checkNoExistingPR(owner, repo, number),
      this.checkNotClaimed(owner, repo, number, ghIssue.comments),
      this.checkProjectHealth(owner, repo),
      this.fetchContributionGuidelines(owner, repo),
    ]);

    // Analyze issue quality
    const clearRequirements = this.analyzeRequirements(ghIssue.body || '');

    const vettingResult: IssueVettingResult = {
      passedAllChecks: noExistingPR && notClaimed && projectHealth.isActive && clearRequirements,
      checks: {
        noExistingPR,
        notClaimed,
        projectActive: projectHealth.isActive,
        clearRequirements,
        contributionGuidelinesFound: !!contributionGuidelines,
      },
      contributionGuidelines,
      notes: [],
    };

    // Build notes
    if (!noExistingPR) vettingResult.notes.push('Existing PR found for this issue');
    if (!notClaimed) vettingResult.notes.push('Issue appears to be claimed by someone');
    if (!projectHealth.isActive) vettingResult.notes.push('Project may be inactive');
    if (!clearRequirements) vettingResult.notes.push('Issue requirements are unclear');
    if (!contributionGuidelines) vettingResult.notes.push('No CONTRIBUTING.md found');

    // Create tracked issue
    const trackedIssue: TrackedIssue = {
      id: ghIssue.id,
      url: issueUrl,
      repo: repoFullName,
      number,
      title: ghIssue.title,
      status: 'candidate',
      labels: ghIssue.labels.map(l => (typeof l === 'string' ? l : l.name || '')),
      createdAt: ghIssue.created_at,
      updatedAt: ghIssue.updated_at,
      vetted: true,
      vettingResult,
    };

    // Determine recommendation
    const reasonsToSkip: string[] = [];
    const reasonsToApprove: string[] = [];

    if (!noExistingPR) reasonsToSkip.push('Has existing PR');
    if (!notClaimed) reasonsToSkip.push('Already claimed');
    if (!projectHealth.isActive) reasonsToSkip.push('Inactive project');
    if (!clearRequirements) reasonsToSkip.push('Unclear requirements');

    if (noExistingPR) reasonsToApprove.push('No existing PR');
    if (notClaimed) reasonsToApprove.push('Not claimed');
    if (projectHealth.isActive) reasonsToApprove.push('Active project');
    if (clearRequirements) reasonsToApprove.push('Clear requirements');
    if (contributionGuidelines) reasonsToApprove.push('Has contribution guidelines');

    // Check if it's a trusted project
    const config = this.stateManager.getState().config;
    if (config.trustedProjects.includes(repoFullName)) {
      reasonsToApprove.push('Trusted project (previous PR merged)');
    }

    let recommendation: 'approve' | 'skip' | 'needs_review';
    if (vettingResult.passedAllChecks) {
      recommendation = 'approve';
    } else if (reasonsToSkip.length > 2) {
      recommendation = 'skip';
    } else {
      recommendation = 'needs_review';
    }

    return {
      issue: trackedIssue,
      vettingResult,
      projectHealth,
      recommendation,
      reasonsToSkip,
      reasonsToApprove,
    };
  }

  private async checkNoExistingPR(owner: string, repo: string, issueNumber: number): Promise<boolean> {
    try {
      // Search for PRs that mention this issue
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:pr ${issueNumber}`,
        per_page: 5,
      });

      // Also check timeline for linked PRs
      const { data: timeline } = await this.octokit.issues.listEventsForTimeline({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      });

      const linkedPRs = timeline.filter(
        (event: any) => event.event === 'cross-referenced' && event.source?.issue?.pull_request
      );

      return data.total_count === 0 && linkedPRs.length === 0;
    } catch {
      return true; // Assume OK if we can't check
    }
  }

  private async checkNotClaimed(
    owner: string,
    repo: string,
    issueNumber: number,
    commentCount: number
  ): Promise<boolean> {
    if (commentCount === 0) return true;

    try {
      // Paginate through all comments (up to 100)
      const comments = await this.octokit.paginate(
        this.octokit.issues.listComments,
        {
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
        },
        (response) => response.data
      );

      // Limit to last 100 comments to avoid excessive processing
      const recentComments = comments.slice(-100);

      // Look for claiming phrases
      const claimPhrases = [
        'i\'m working on this',
        'i am working on this',
        'i\'ll take this',
        'i will take this',
        'working on it',
        'i\'d like to work on',
        'i would like to work on',
        'can i work on',
        'may i work on',
        'assigned to me',
        'i\'m on it',
        'i\'ll submit a pr',
        'i will submit a pr',
        'working on a fix',
        'working on a pr',
      ];

      for (const comment of recentComments) {
        const body = (comment.body || '').toLowerCase();
        if (claimPhrases.some(phrase => body.includes(phrase))) {
          return false;
        }
      }

      return true;
    } catch {
      return true;
    }
  }

  private async checkProjectHealth(owner: string, repo: string): Promise<ProjectHealth> {
    try {
      // Get repo info
      const { data: repoData } = await this.octokit.repos.get({ owner, repo });

      // Get recent commits
      const { data: commits } = await this.octokit.repos.listCommits({
        owner,
        repo,
        per_page: 1,
      });

      const lastCommit = commits[0];
      const lastCommitAt = lastCommit?.commit?.author?.date || repoData.pushed_at;
      const daysSinceLastCommit = daysBetween(new Date(lastCommitAt));

      // Check CI status (simplified - just check if workflows exist)
      let ciStatus: 'passing' | 'failing' | 'unknown' = 'unknown';
      try {
        const { data: workflows } = await this.octokit.actions.listRepoWorkflows({
          owner,
          repo,
          per_page: 1,
        });
        if (workflows.total_count > 0) {
          ciStatus = 'passing'; // Assume passing if workflows exist
        }
      } catch {
        // Ignore - CI status unknown
      }

      return {
        repo: `${owner}/${repo}`,
        lastCommitAt,
        daysSinceLastCommit,
        openIssuesCount: repoData.open_issues_count,
        avgIssueResponseDays: 0, // Would need more API calls to calculate
        ciStatus,
        isActive: daysSinceLastCommit < 30,
      };
    } catch (error) {
      console.error(`Error checking project health for ${owner}/${repo}:`, error);
      return {
        repo: `${owner}/${repo}`,
        lastCommitAt: '',
        daysSinceLastCommit: 999,
        openIssuesCount: 0,
        avgIssueResponseDays: 0,
        ciStatus: 'unknown',
        isActive: false,
      };
    }
  }

  private async fetchContributionGuidelines(
    owner: string,
    repo: string
  ): Promise<ContributionGuidelines | undefined> {
    const cacheKey = `${owner}/${repo}`;

    // Check cache first
    const cached = guidelinesCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      return cached.guidelines;
    }

    const filesToCheck = [
      'CONTRIBUTING.md',
      '.github/CONTRIBUTING.md',
      'docs/CONTRIBUTING.md',
      'contributing.md',
    ];

    for (const file of filesToCheck) {
      try {
        const { data } = await this.octokit.repos.getContent({
          owner,
          repo,
          path: file,
        });

        if ('content' in data) {
          const content = Buffer.from(data.content, 'base64').toString('utf-8');
          const guidelines = this.parseContributionGuidelines(content);

          // Cache the result and prune if needed
          guidelinesCache.set(cacheKey, { guidelines, fetchedAt: Date.now() });
          pruneCache();
          return guidelines;
        }
      } catch {
        // File not found, try next
      }
    }

    // Cache the negative result too and prune if needed
    guidelinesCache.set(cacheKey, { guidelines: undefined, fetchedAt: Date.now() });
    pruneCache();
    return undefined;
  }

  private parseContributionGuidelines(content: string): ContributionGuidelines {
    const guidelines: ContributionGuidelines = {
      rawContent: content,
    };

    const lowerContent = content.toLowerCase();

    // Detect branch naming conventions
    if (lowerContent.includes('branch')) {
      const branchMatch = content.match(/branch[^\n]*(?:named?|format|convention)[^\n]*[`"]([^`"]+)[`"]/i);
      if (branchMatch) {
        guidelines.branchNamingConvention = branchMatch[1];
      }
    }

    // Detect commit message format
    if (lowerContent.includes('conventional commit')) {
      guidelines.commitMessageFormat = 'conventional commits';
    } else if (lowerContent.includes('commit message')) {
      const commitMatch = content.match(/commit message[^\n]*[`"]([^`"]+)[`"]/i);
      if (commitMatch) {
        guidelines.commitMessageFormat = commitMatch[1];
      }
    }

    // Detect test framework
    if (lowerContent.includes('jest')) guidelines.testFramework = 'Jest';
    else if (lowerContent.includes('rspec')) guidelines.testFramework = 'RSpec';
    else if (lowerContent.includes('pytest')) guidelines.testFramework = 'pytest';
    else if (lowerContent.includes('mocha')) guidelines.testFramework = 'Mocha';

    // Detect linter
    if (lowerContent.includes('eslint')) guidelines.linter = 'ESLint';
    else if (lowerContent.includes('rubocop')) guidelines.linter = 'RuboCop';
    else if (lowerContent.includes('prettier')) guidelines.formatter = 'Prettier';

    // Detect CLA requirement
    if (lowerContent.includes('cla') || lowerContent.includes('contributor license agreement')) {
      guidelines.claRequired = true;
    }

    return guidelines;
  }

  private analyzeRequirements(body: string): boolean {
    if (!body || body.length < 50) return false;

    // Check for clear structure
    const hasSteps = /\d+\.|[-*]\s/.test(body);
    const hasCodeBlock = /```/.test(body);
    const hasExpectedBehavior = /expect|should|must|want/i.test(body);

    // Must have at least two indicators of clarity
    const indicators = [hasSteps, hasCodeBlock, hasExpectedBehavior, body.length > 200];
    return indicators.filter(Boolean).length >= 2;
  }

  /**
   * Format issue candidate for display
   */
  formatCandidate(candidate: IssueCandidate): string {
    const { issue, vettingResult, projectHealth, recommendation, reasonsToApprove, reasonsToSkip } = candidate;

    const statusIcon = recommendation === 'approve' ? '✅' : recommendation === 'skip' ? '❌' : '⚠️';

    return `
## ${statusIcon} Issue Candidate: ${issue.repo}#${issue.number}

**Title:** ${issue.title}
**Labels:** ${issue.labels.join(', ')}
**Created:** ${new Date(issue.createdAt).toLocaleDateString()}
**URL:** ${issue.url}

### Vetting Results
${Object.entries(vettingResult.checks)
  .map(([key, passed]) => `- ${passed ? '✓' : '✗'} ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}`)
  .join('\n')}

### Project Health
- Last commit: ${projectHealth.daysSinceLastCommit} days ago
- Open issues: ${projectHealth.openIssuesCount}
- CI status: ${projectHealth.ciStatus}

### Recommendation: **${recommendation.toUpperCase()}**
${reasonsToApprove.length > 0 ? `\n**Reasons to approve:**\n${reasonsToApprove.map(r => `- ${r}`).join('\n')}` : ''}
${reasonsToSkip.length > 0 ? `\n**Reasons to skip:**\n${reasonsToSkip.map(r => `- ${r}`).join('\n')}` : ''}
${vettingResult.notes.length > 0 ? `\n**Notes:**\n${vettingResult.notes.map(n => `- ${n}`).join('\n')}` : ''}
`;
  }
}
