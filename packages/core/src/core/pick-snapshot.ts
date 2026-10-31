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
  const { competingPRs = fromScout, ...rest } = traits;
  const recorded = Object.entries({ ...rest, competingPRs }).filter(([, value]) => value !== undefined);
  return {
    issueUrl: vet.issue.url,
    grade: vet.grade.score,
    recommendation: vet.recommendation,
    // Stars at pick time feed the eval's repo-size cut (#1825); not recoverable later.
    ...(typeof stars === 'number' && { stargazersCount: stars }),
    source,
    capturedAt: new Date().toISOString(),
    labels: vet.issue.labels,
    ...(Object.fromEntries(recorded) as PickTraits),
  };
}

/** Vet-time facts the vet output itself does not carry. All optional: each is best-effort. */
export interface PickTraits {
  /** GitHub author association of the issue author, raw (OWNER, NONE, ...). */
  issueAuthorAssociation?: string;
  issueAuthorIsBot?: boolean;
  commentCount?: number;
  /** Open, non-draft closing PRs by others, when the caller has a verification. */
  competingPRs?: number;
  /** Open PRs by others that only cross-reference the issue. */
  mentioningPRs?: number;
  firstInRepo?: boolean;
}

/** The pick traits a verification already carries, so a pick costs no extra API call. */
export function traitsFromVerification(v: IssueVerification): PickTraits {
  const open = v.linkedPRs.filter((pr) => pr.state === 'open' && !pr.isOwn);
  return {
    ...(v.authorAssociation !== null && { issueAuthorAssociation: v.authorAssociation }),
    issueAuthorIsBot: v.authorIsBot,
    ...(v.commentCount !== null && { commentCount: v.commentCount }),
    // Only a closing PR is a claim; a cross-reference is a mention (see issue-verification).
    competingPRs: open.filter((pr) => pr.linkType === 'closing' && !pr.isDraft).length,
    mentioningPRs: open.filter((pr) => pr.linkType === 'cross-referenced').length,
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
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE, () =>
    stateManager.recordPickSnapshots(snapshots),
  );
  return gistSyncWarning ? { gistSyncWarning } : {};
}
