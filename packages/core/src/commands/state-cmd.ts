/**
 * State persistence management commands.
 * Provides --show, --sync, and --unlink subcommands for the Gist persistence layer.
 */

import * as fs from 'node:fs';
import { getStateManager, resetStateManager } from '../core/state.js';
import { atomicWriteFileSync } from '../core/state-persistence.js';
import { getStatePath, getGistIdPath } from '../core/paths.js';
import { parseGitHubUrl } from '../core/urls.js';
import { warn } from '../core/logger.js';

const MODULE = 'state-cmd';

export interface InvalidUrlEntry {
  kind: 'merged' | 'closed';
  url: string;
  title: string;
}

export interface StateShowOutput {
  persistence: 'local' | 'gist';
  gistId: string | null;
  gistDegraded: boolean;
  lastRunAt: string | undefined;
  /** Present only when validate=true. Existing entries with unparseable URLs. */
  invalidEntries?: InvalidUrlEntry[];
}

export interface StateSyncOutput {
  pushed: boolean;
  gistId: string | null;
}

export interface StateUnlinkOutput {
  unlinked: boolean;
  localStatePath: string;
  previousGistId: string | null;
}

export async function runStateShow(options: { validate?: boolean } = {}): Promise<StateShowOutput> {
  const sm = getStateManager();
  const state = sm.getState();
  const output: StateShowOutput = {
    persistence: state.config.persistence ?? 'local',
    gistId: state.gistId ?? null,
    gistDegraded: sm.isGistDegraded(),
    lastRunAt: state.lastRunAt,
  };
  if (options.validate) {
    output.invalidEntries = collectInvalidUrlEntries(sm);
  }
  return output;
}

function collectInvalidUrlEntries(sm: ReturnType<typeof getStateManager>): InvalidUrlEntry[] {
  const invalid: InvalidUrlEntry[] = [];
  for (const pr of sm.getMergedPRs()) {
    if (parseGitHubUrl(pr.url) === null) {
      invalid.push({ kind: 'merged', url: pr.url, title: pr.title });
    }
  }
  for (const pr of sm.getClosedPRs()) {
    if (parseGitHubUrl(pr.url) === null) {
      invalid.push({ kind: 'closed', url: pr.url, title: pr.title });
    }
  }
  return invalid;
}

export async function runStateSync(): Promise<StateSyncOutput> {
  const sm = getStateManager();
  if (!sm.isGistMode()) {
    return { pushed: false, gistId: null };
  }
  const pushed = await sm.checkpoint();
  if (!pushed) {
    throw new Error('Failed to push state to Gist after retry. Check network connectivity and token permissions.');
  }
  return { pushed: true, gistId: sm.getState().gistId ?? null };
}

export async function runStateUnlink(): Promise<StateUnlinkOutput> {
  const sm = getStateManager();
  const state = sm.getState();
  const previousGistId = state.gistId ?? null;
  const statePath = getStatePath();

  // Refresh from Gist to get the latest state before unlinking
  if (sm.isGistMode()) {
    await sm.refreshFromGist();
  }

  // Write current state to local state.json with persistence set to local
  const localState = JSON.parse(JSON.stringify(sm.getState()));
  delete localState.gistId;
  localState.config.persistence = 'local';
  atomicWriteFileSync(statePath, JSON.stringify(localState, null, 2), 0o600);

  // Remove the gist-id file so future startups don't try to use the Gist
  const gistIdPath = getGistIdPath();
  try {
    if (fs.existsSync(gistIdPath)) {
      fs.unlinkSync(gistIdPath);
    }
  } catch (err) {
    warn(MODULE, `Failed to remove gist-id file: ${err}`);
  }

  // Do NOT delete the remote Gist — the user may want it as a backup

  // Reset the singleton so subsequent calls in this process use local mode
  resetStateManager();

  return {
    unlinked: true,
    localStatePath: statePath,
    previousGistId,
  };
}
