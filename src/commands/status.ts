/**
 * Status command
 * Shows current status and stats
 */

import { getStateManager } from '../core/index.js';
import { outputJson, type StatusOutput } from '../formatters/json.js';

interface StatusOptions {
  json?: boolean;
}

export async function runStatus(options: StatusOptions): Promise<void> {
  const stateManager = getStateManager();
  const stats = stateManager.getStats();
  const state = stateManager.getState();

  if (options.json) {
    // Extract only the stats we want to output (exclude totalTracked)
    const { totalTracked, ...outputStats } = stats as typeof stats & { totalTracked?: number };
    outputJson<StatusOutput>({
      stats: outputStats,
      activePRs: [...state.activePRs],
      dormantPRs: [...state.dormantPRs],
      lastRunAt: state.lastRunAt,
    });
  } else {
    // Simple console output
    console.log('\n📊 OSS Status\n');
    console.log(`Active PRs: ${stats.activePRs}`);
    console.log(`Dormant PRs: ${stats.dormantPRs}`);
    console.log(`Merged PRs: ${stats.mergedPRs}`);
    console.log(`Closed PRs: ${stats.closedPRs}`);
    console.log(`Merge Rate: ${stats.mergeRate}`);
    console.log(`Needs Response: ${stats.needsResponse}`);
    console.log(`\nLast Run: ${state.lastRunAt || 'Never'}`);

    if (state.activePRs.length > 0) {
      console.log('\nActive PRs:');
      for (const pr of state.activePRs) {
        const status = pr.hasUnreadComments ? '💬' : '✓';
        console.log(`  ${status} ${pr.repo}#${pr.number}: ${pr.title}`);
      }
    }

    console.log('\nRun with --json for structured output');
  }
}
