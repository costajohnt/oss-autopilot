/**
 * repo-cap command: per-repo open-PR cap and excludeRepos check for one repo,
 * read from local state. Used by the draft-first workflow before `gh pr create`.
 */

import { getStateManager } from '../core/index.js';
import { getRepoCapStatus, type RepoCapStatus } from '../core/repo-cap.js';
import { validateRepoIdentifier } from './validation.js';

export function runRepoCap(options: { repo: string }): RepoCapStatus {
  return getRepoCapStatus(getStateManager().getState(), validateRepoIdentifier(options.repo));
}
