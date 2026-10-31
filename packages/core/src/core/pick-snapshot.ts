/**
 * Vet-time predictions for calibration (#1824): what `vet` / `vet-list`
 * thought of an issue, kept so the outcome ledger can compare it against how
 * the PR that closed the issue actually ended.
 */

import type { VetOutput } from '../formatters/json.js';
import { errorMessage } from './errors.js';
import type { IssueVerification } from './issue-verification.js';
import { warn } from './logger.js';
import { maybeCheckpoint, type StateManager } from './state.js';
import type { PickSnapshot, RepoScore, StoredMergedPR } from './types.js';

const MODULE = 'pick-snapshot';

/**
 * The prediction to keep for a vetted issue, or undefined when the user's own
 * PR is already linked: scout then grades the issue as taken, which is a
 * post-hoc verdict, not the prediction that picked it.
 */
// ponytail: scout reports only the first linked PR, so a standalone `vet` of an
// issue whose first reference is someone else's PR can still miss the user's
// own. First-wins in recordPickSnapshots limits this to never-vetted issues.
export function pickSnapshotFromVet(
  vet: VetOutput,
  source: PickSnapshot['source'],
  traits: PickTraits = {},
): PickSnapshot | undefined {
  if (vet.linkedPRClassification?.startsWith('user_')) return undefined;
  const stars = (vet.projectHealth as { stargazersCount?: unknown } | null | undefined)?.stargazersCount;
  // ponytail: when verification failed, scout's first linked PR gives a 0/1
  // lower bound; callers pass the verified count otherwise.
  const fromScout = vet.linkedPRClassification && Number(vet.linkedPRClassification === 'other_open');
  const competingPRs = traits.competingPRs ?? fromScout;
  return {
    issueUrl: vet.issue.url,
    grade: vet.grade.score,
    recommendation: vet.recommendation,
    // Stars at pick time feed the eval's repo-size cut (#1825); not recoverable later.
    ...(typeof stars === 'number' && { stargazersCount: stars }),
    source,
    capturedAt: new Date().toISOString(),
    labels: vet.issue.labels,
    ...(traits.authorAssociation !== undefined && { issueAuthorAssociation: traits.authorAssociation }),
    ...(traits.authorIsBot !== undefined && { issueAuthorIsBot: traits.authorIsBot }),
    ...(competingPRs !== undefined && { competingPRs }),
    ...(traits.firstInRepo !== undefined && { firstInRepo: traits.firstInRepo }),
    ...(traits.commentCount !== undefined && { commentCount: traits.commentCount }),
  };
}

/** Vet-time facts the vet output itself does not carry. All optional: each is best-effort. */
export interface PickTraits {
  /** GitHub author association of the issue author, raw (OWNER, NONE, ...). */
  authorAssociation?: string;
  authorIsBot?: boolean;
  commentCount?: number;
  /** {@link competingPRCount}, when the caller has a verification. */
  competingPRs?: number;
  firstInRepo?: boolean;
}

/** Open PRs by others that really compete: closing the issue, or in the issue's repo. Drafts are left out. */
export function competingPRCount(v: Pick<IssueVerification, 'owner' | 'repo' | 'linkedPRs'>): number {
  const sameRepo = `https://github.com/${v.owner}/${v.repo}/pull/`.toLowerCase();
  return v.linkedPRs.filter(
    (pr) =>
      pr.state === 'open' &&
      !pr.isOwn &&
      !pr.isDraft &&
      (pr.linkType === 'closing' || pr.url.toLowerCase().startsWith(sameRepo)),
  ).length;
}

/** The pick traits a verification already carries, so a pick costs no extra API call. */
export function traitsFromVerification(v: IssueVerification): PickTraits {
  return {
    ...(v.authorAssociation !== null && { authorAssociation: v.authorAssociation }),
    authorIsBot: v.authorIsBot,
    ...(v.commentCount !== null && { commentCount: v.commentCount }),
    competingPRs: competingPRCount(v),
  };
}

/** True when neither the repo score nor the merged ledger shows a merged PR by the user in `repo`. */
export function isFirstInRepo(
  repo: string,
  repoScore: Pick<RepoScore, 'mergedPRCount'> | undefined,
  mergedPRs: ReadonlyArray<Pick<StoredMergedPR, 'url'>> | undefined,
): boolean {
  if ((repoScore?.mergedPRCount ?? 0) > 0) return false;
  const prefix = `https://github.com/${repo}/`.toLowerCase();
  return (mergedPRs ?? []).every((pr) => !pr.url.toLowerCase().startsWith(prefix));
}

/**
 * Persist predictions without ever failing the vet that produced them. `vet`
 * used to be read-only, so a state save here can race another writer; that
 * and a failed Gist push (#1629) come back as envelope fields instead.
 */
export async function persistPickSnapshots(
  stateManager: StateManager,
  snapshots: PickSnapshot[],
): Promise<{ pickRecordError?: string; gistSyncWarning?: string }> {
  if (snapshots.length === 0) return {};
  try {
    stateManager.reloadIfChanged();
    stateManager.recordPickSnapshots(snapshots);
  } catch (error) {
    const pickRecordError = `Could not record the vet prediction: ${errorMessage(error)}`;
    warn(MODULE, pickRecordError);
    return { pickRecordError };
  }
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);
  return gistSyncWarning ? { gistSyncWarning } : {};
}
