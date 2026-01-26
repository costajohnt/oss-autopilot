/**
 * Vet command
 * Vets a specific issue before working on it
 */

import { IssueDiscovery } from '../core/index.js';
import { outputJson, outputJsonError } from '../formatters/json.js';

interface VetOptions {
  issueUrl: string;
  json?: boolean;
}

export async function runVet(options: VetOptions): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (options.json) {
      outputJsonError('GITHUB_TOKEN environment variable is required');
    } else {
      console.error('Error: GITHUB_TOKEN environment variable is required');
      console.error('Set it with: export GITHUB_TOKEN=$(gh auth token)');
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
