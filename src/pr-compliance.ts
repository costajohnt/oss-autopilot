/**
 * PR Compliance Checker - Validates PRs against opensource.guide best practices
 * https://opensource.guide/how-to-contribute/
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { parseGitHubUrl } from './utils.js';
import {
  PRComplianceCheck,
  PRComplianceResult,
  ContributionGuidelines,
} from './types.js';

export class PRComplianceChecker {
  private octokit: Octokit;

  constructor(githubToken: string) {
    this.octokit = getOctokit(githubToken);
  }

  /**
   * Check a PR against opensource.guide best practices
   */
  async checkPR(prUrl: string): Promise<PRComplianceResult> {
    const parsed = parseGitHubUrl(prUrl);
    if (!parsed || parsed.type !== 'pull') {
      throw new Error(`Invalid PR URL: ${prUrl}`);
    }

    const { owner, repo, number } = parsed;
    const repoFullName = `${owner}/${repo}`;

    // Fetch PR data
    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: number,
    });

    // Fetch PR files to check for tests
    const { data: files } = await this.octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });

    // Fetch contribution guidelines
    const guidelines = await this.fetchContributionGuidelines(owner, repo);

    // Run all checks
    const checks: PRComplianceCheck[] = [];

    // Check 1: Issue reference
    checks.push(this.checkIssueReference(pr.body || '', pr.title));

    // Check 2: PR description quality
    checks.push(this.checkDescriptionQuality(pr.body || ''));

    // Check 3: Focused changes (not too many files)
    checks.push(this.checkFocusedChanges(files.length, pr.additions, pr.deletions));

    // Check 4: Tests included
    checks.push(this.checkTestsIncluded(files, guidelines));

    // Check 5: Title quality
    checks.push(this.checkTitleQuality(pr.title));

    // Check 6: No WIP/Draft without marking
    checks.push(this.checkNotWIP(pr.title, pr.draft ?? false));

    // Check 7: Branch naming (if guidelines specify)
    checks.push(this.checkBranchNaming(pr.head.ref, guidelines));

    // Calculate overall result
    const errorCount = checks.filter(c => !c.passed && c.severity === 'error').length;
    const warningCount = checks.filter(c => !c.passed && c.severity === 'warning').length;
    const passedCount = checks.filter(c => c.passed).length;

    const score = Math.round((passedCount / checks.length) * 100);
    const overallPassed = errorCount === 0;

    // Generate suggestions
    const suggestions = this.generateSuggestions(checks, guidelines);

    return {
      prUrl,
      repo: repoFullName,
      number,
      title: pr.title,
      overallPassed,
      checks,
      score,
      suggestions,
    };
  }

  private checkIssueReference(body: string, title: string): PRComplianceCheck {
    const combined = `${title} ${body}`.toLowerCase();

    // Look for issue references: #123, closes #123, fixes #123, resolves #123
    const hasReference = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*#\d+/i.test(combined) ||
                        /#\d+/.test(combined);

    return {
      name: 'Issue Reference',
      passed: hasReference,
      message: hasReference
        ? 'PR references an issue'
        : 'PR should reference the issue it addresses (e.g., "Closes #123")',
      severity: 'warning',
    };
  }

  private checkDescriptionQuality(body: string): PRComplianceCheck {
    const minLength = 50;
    const hasDescription = body.length >= minLength;

    // Check for common good practices in PR descriptions
    const hasWhatSection = /##?\s*(what|summary|changes|description)/i.test(body);
    const hasWhySection = /##?\s*(why|motivation|context|reason)/i.test(body);
    const hasBulletPoints = /^[-*]\s/m.test(body);
    const hasCheckboxes = /\[[ x]\]/i.test(body);

    const qualityScore = [hasDescription, hasWhatSection || hasWhySection, hasBulletPoints || hasCheckboxes]
      .filter(Boolean).length;

    const passed = hasDescription && qualityScore >= 1;

    return {
      name: 'Description Quality',
      passed,
      message: passed
        ? 'PR has a descriptive body explaining the changes'
        : 'PR description should explain what changes were made and why',
      severity: 'warning',
    };
  }

  private checkFocusedChanges(fileCount: number, additions: number, deletions: number): PRComplianceCheck {
    const totalChanges = additions + deletions;

    // Thresholds for focused PRs
    const maxFiles = 20;
    const maxChanges = 500;

    const isFocused = fileCount <= maxFiles && totalChanges <= maxChanges;

    let message: string;
    if (isFocused) {
      message = `PR is focused (${fileCount} files, ${totalChanges} lines changed)`;
    } else if (fileCount > maxFiles) {
      message = `PR touches ${fileCount} files - consider splitting into smaller PRs`;
    } else {
      message = `PR has ${totalChanges} lines changed - consider splitting into smaller PRs`;
    }

    return {
      name: 'Focused Changes',
      passed: isFocused,
      message,
      severity: fileCount > 50 || totalChanges > 1000 ? 'warning' : 'info',
    };
  }

  private checkTestsIncluded(
    files: Array<{ filename: string }>,
    guidelines?: ContributionGuidelines
  ): PRComplianceCheck {
    // Common test file patterns
    const testPatterns = [
      /\.test\.[jt]sx?$/,
      /\.spec\.[jt]sx?$/,
      /_test\.[jt]sx?$/,
      /_spec\.[jt]sx?$/,
      /test_.*\.py$/,
      /.*_test\.py$/,
      /.*_spec\.rb$/,
      /spec\/.*\.rb$/,
      /tests?\/.*\.[jt]sx?$/,
      /__tests__\/.*\.[jt]sx?$/,
    ];

    const hasTestFiles = files.some(f =>
      testPatterns.some(pattern => pattern.test(f.filename))
    );

    // Check if this looks like a code change (vs docs-only)
    const codePatterns = [/\.[jt]sx?$/, /\.py$/, /\.rb$/, /\.go$/, /\.rs$/];
    const hasCodeChanges = files.some(f =>
      codePatterns.some(pattern => pattern.test(f.filename)) &&
      !testPatterns.some(pattern => pattern.test(f.filename))
    );

    // If no code changes, tests aren't required
    if (!hasCodeChanges) {
      return {
        name: 'Tests Included',
        passed: true,
        message: 'No code changes detected - tests not required',
        severity: 'info',
      };
    }

    // Check if project requires tests
    const testsRequired = guidelines?.testCoverageRequired ?? true;

    return {
      name: 'Tests Included',
      passed: hasTestFiles || !testsRequired,
      message: hasTestFiles
        ? 'PR includes test files'
        : testsRequired
          ? 'PR should include tests for code changes'
          : 'Consider adding tests for code changes',
      severity: testsRequired ? 'warning' : 'info',
    };
  }

  private checkTitleQuality(title: string): PRComplianceCheck {
    const minLength = 10;
    const maxLength = 72;

    // Check for conventional commit format
    const hasConventionalFormat = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build)(\(.+\))?:\s/.test(title);

    // Check for good title characteristics
    const hasGoodLength = title.length >= minLength && title.length <= maxLength;
    const startsWithVerb = /^(add|fix|update|remove|refactor|improve|implement|create|delete|change|move|rename)/i.test(title);
    const notWIP = !/^(wip|work in progress|draft)/i.test(title);

    const passed = hasGoodLength && (hasConventionalFormat || startsWithVerb) && notWIP;

    let message: string;
    if (passed) {
      message = 'PR title is descriptive and well-formatted';
    } else if (title.length < minLength) {
      message = 'PR title is too short - should be descriptive';
    } else if (title.length > maxLength) {
      message = `PR title is too long (${title.length} chars) - keep under ${maxLength}`;
    } else {
      message = 'PR title should start with a verb or use conventional commit format';
    }

    return {
      name: 'Title Quality',
      passed,
      message,
      severity: 'info',
    };
  }

  private checkNotWIP(title: string, isDraft: boolean): PRComplianceCheck {
    const hasWIPInTitle = /\b(wip|work in progress)\b/i.test(title);

    if (hasWIPInTitle && !isDraft) {
      return {
        name: 'Draft Status',
        passed: false,
        message: 'PR has WIP in title but is not marked as draft - consider converting to draft PR',
        severity: 'warning',
      };
    }

    return {
      name: 'Draft Status',
      passed: true,
      message: isDraft ? 'PR is correctly marked as draft' : 'PR is ready for review',
      severity: 'info',
    };
  }

  private checkBranchNaming(branchName: string, guidelines?: ContributionGuidelines): PRComplianceCheck {
    // If guidelines specify a convention, check against it
    if (guidelines?.branchNamingConvention) {
      const pattern = new RegExp(guidelines.branchNamingConvention);
      const matches = pattern.test(branchName);

      return {
        name: 'Branch Naming',
        passed: matches,
        message: matches
          ? 'Branch name follows project convention'
          : `Branch name should match pattern: ${guidelines.branchNamingConvention}`,
        severity: 'info',
      };
    }

    // Default: check for common good patterns
    const goodPatterns = [
      /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build)\//, // conventional
      /^(feature|bugfix|hotfix|release)\//, // gitflow
      /^[a-z0-9-]+$/, // simple kebab-case
    ];

    const hasGoodPattern = goodPatterns.some(p => p.test(branchName));

    return {
      name: 'Branch Naming',
      passed: hasGoodPattern,
      message: hasGoodPattern
        ? 'Branch name follows a clear convention'
        : 'Consider using a descriptive branch name (e.g., feat/add-feature)',
      severity: 'info',
    };
  }

  private async fetchContributionGuidelines(
    owner: string,
    repo: string
  ): Promise<ContributionGuidelines | undefined> {
    const filesToCheck = [
      'CONTRIBUTING.md',
      '.github/CONTRIBUTING.md',
      'docs/CONTRIBUTING.md',
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
          return this.parseContributionGuidelines(content);
        }
      } catch {
        // File not found, try next
      }
    }

    return undefined;
  }

  private parseContributionGuidelines(content: string): ContributionGuidelines {
    const guidelines: ContributionGuidelines = {
      rawContent: content,
    };

    const lowerContent = content.toLowerCase();

    // Detect test requirements
    if (lowerContent.includes('test') && (lowerContent.includes('require') || lowerContent.includes('must'))) {
      guidelines.testCoverageRequired = true;
    }

    // Detect branch naming
    const branchMatch = content.match(/branch[^\n]*(?:named?|format|convention)[^\n]*[`"]([^`"]+)[`"]/i);
    if (branchMatch) {
      guidelines.branchNamingConvention = branchMatch[1];
    }

    // Detect commit message format
    if (lowerContent.includes('conventional commit')) {
      guidelines.commitMessageFormat = 'conventional commits';
    }

    return guidelines;
  }

  private generateSuggestions(
    checks: PRComplianceCheck[],
    guidelines?: ContributionGuidelines
  ): string[] {
    const suggestions: string[] = [];

    // Add suggestions for failed checks
    for (const check of checks) {
      if (!check.passed && check.severity !== 'info') {
        suggestions.push(check.message);
      }
    }

    // Add general suggestions
    if (!guidelines) {
      suggestions.push('No CONTRIBUTING.md found - check the project README for contribution guidelines');
    }

    return suggestions;
  }

  /**
   * Format compliance result for display
   */
  formatResult(result: PRComplianceResult): string {
    const statusIcon = result.overallPassed ? '✅' : '⚠️';
    const scoreEmoji = result.score >= 80 ? '🌟' : result.score >= 60 ? '👍' : '📝';

    let output = `
## ${statusIcon} PR Compliance Check: ${result.repo}#${result.number}

**Title:** ${result.title}
**Score:** ${scoreEmoji} ${result.score}/100
**URL:** ${result.prUrl}

### Checks
`;

    for (const check of result.checks) {
      const icon = check.passed ? '✓' : check.severity === 'error' ? '✗' : '⚠';
      output += `- ${icon} **${check.name}**: ${check.message}\n`;
    }

    if (result.suggestions.length > 0) {
      output += `\n### Suggestions for Improvement\n`;
      for (const suggestion of result.suggestions) {
        output += `- ${suggestion}\n`;
      }
    }

    output += `\n### opensource.guide Reference
See https://opensource.guide/how-to-contribute/ for best practices.
`;

    return output;
  }
}
