/**
 * Vet command
 * Vets a specific issue before working on it
 */

import { IssueDiscovery, getGitHubToken } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

interface VetOptions {
  issueUrl: string;
  json?: boolean;
}

export async function runVet(options: VetOptions): Promise<void> {
  const token = getGitHubToken();
  if (!token) {
    if (options.json) {
      outputJsonError('GitHub authentication required. Run "gh auth login" or set GITHUB_TOKEN.');
    } else {
      console.error('Error: GitHub authentication required.');
      console.error('');
      console.error('Options:');
      console.error('  1. Use gh CLI: gh auth login');
      console.error('  2. Set GITHUB_TOKEN environment variable');
    }
    process.exit(1);
  }

  const discovery = new IssueDiscovery(token);

  if (!options.json) {
    console.log(`\n🔍 Vetting issue: ${options.issueUrl}\n`);
  }

  const candidate = await discovery.vetIssue(options.issueUrl);

  if (options.json) {
    outputJson({
      issue: {
        repo: candidate.issue.repo,
        number: candidate.issue.number,
        title: candidate.issue.title,
        url: candidate.issue.url,
        labels: candidate.issue.labels,
      },
      recommendation: candidate.recommendation,
      reasonsToApprove: candidate.reasonsToApprove,
      reasonsToSkip: candidate.reasonsToSkip,
      projectHealth: candidate.projectHealth,
      vettingResult: candidate.vettingResult,
    });
  } else {
    console.log(discovery.formatCandidate(candidate));
  }
}
