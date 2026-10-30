/**
 * Vet-time predictions for calibration (#1824): what `vet` / `vet-list`
 * thought of an issue, kept so the outcome ledger can compare it against how
 * the PR that closed the issue actually ended.
 */

import type { VetOutput } from '../formatters/json.js';
import { errorMessage } from './errors.js';
import { warn } from './logger.js';
import { maybeCheckpoint, type StateManager } from './state.js';
import type { PickSnapshot } from './types.js';

const MODULE = 'pick-snapshot';

/**
 * The prediction to keep for a vetted issue, or undefined when the user's own
 * PR is already linked: scout then grades the issue as taken, which is a
 * post-hoc verdict, not the prediction that picked it.
 */
export function pickSnapshotFromVet(vet: VetOutput, source: PickSnapshot['source']): PickSnapshot | undefined {
  if (vet.linkedPRClassification?.startsWith('user_')) return undefined;
  const stars = (vet.projectHealth as { stargazersCount?: unknown } | null | undefined)?.stargazersCount;
  return {
    issueUrl: vet.issue.url,
    grade: vet.grade.score,
    recommendation: vet.recommendation,
    // Stars at pick time feed the eval's repo-size cut (#1825); not recoverable later.
    ...(typeof stars === 'number' && { stargazersCount: stars }),
    source,
    capturedAt: new Date().toISOString(),
  };
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
