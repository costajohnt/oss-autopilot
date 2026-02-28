/**
 * Vet command
 * Vets a specific issue before working on it
 */

import { IssueDiscovery, getGitHubToken } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import { validateUrl } from './validation.js';

interface VetOptions {
  issueUrl: string;
  json?: boolean;
}

export async function runVet(options: VetOptions): Promise<void> {
  validateUrl(options.issueUrl);

  // Token is guaranteed by the preAction hook in cli.ts for non-LOCAL_ONLY_COMMANDS.
  const token = getGitHubToken()!;

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
