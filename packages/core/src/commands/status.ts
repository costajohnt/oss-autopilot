/**
 * Status command
 * Shows current status and stats
 */

import { getStateManager } from '../core/index.js';
import { outputJson, type StatusOutput } from '../formatters/json.js';

interface StatusOptions {
  json?: boolean;
  offline?: boolean;
}

export async function runStatus(options: StatusOptions): Promise<void> {
  const stateManager = getStateManager();
  const stats = stateManager.getStats();
  const state = stateManager.getState();

  // Status always reads from local state (no API calls), so offline mode
  // simply adds metadata about cache freshness.
  const lastUpdated = state.lastDigestAt || state.lastRunAt;

  if (options.json) {
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
    outputJson<StatusOutput>(output);
  } else {
    // Simple console output
    console.log('\n📊 OSS Status\n');
    console.log(`Merged PRs: ${stats.mergedPRs}`);
    console.log(`Closed PRs: ${stats.closedPRs}`);
    console.log(`Merge Rate: ${stats.mergeRate}`);
    console.log(`Needs Response: ${stats.needsResponse}`);
    if (options.offline) {
      console.log(`\nLast Updated: ${lastUpdated || 'Never'}`);
      console.log('(Offline mode: showing cached data)');
    } else {
      console.log(`\nLast Run: ${state.lastRunAt || 'Never'}`);
    }
    console.log('\nRun with --json for structured output');
  }
}
