/**
 * Status command
 * Shows current status and stats
 */

import { getStateManager } from '../core/index.js';
import type { StatusOutput } from '../formatters/json.js';

interface StatusOptions {
  offline?: boolean;
}

export type { StatusOutput };

export async function runStatus(options: StatusOptions): Promise<StatusOutput> {
  const stateManager = getStateManager();
  const stats = stateManager.getStats();
  const state = stateManager.getState();

  // Status always reads from local state (no API calls), so offline mode
  // simply adds metadata about cache freshness.
  const lastUpdated = state.lastDigestAt || state.lastRunAt;

  // Extract only the stats we want to output (exclude totalTracked)
  const { totalTracked: _totalTracked, ...outputStats } = stats as typeof stats & { totalTracked?: number };
  const output: StatusOutput = {
    stats: outputStats,
    lastRunAt: state.lastRunAt,
  };
  if (options.offline) {
    output.offline = true;
    output.lastUpdated = lastUpdated;
  }

  return output;
}
