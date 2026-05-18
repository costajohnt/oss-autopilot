/**
 * strategy command (#1243 step 4).
 *
 * Runs the typed `computeStrategy` core function against local state on
 * demand. The daily auto-display already emits `strategySummary` under
 * a cadence gate; this command is the *ungated* path used by the
 * `contribution-strategist` agent so a user asking "how am I doing?"
 * always gets an answer (or a clear "not enough data yet" message) even
 * when the daily cadence has not fired.
 *
 * Read-only: no API calls, no state mutation.
 */

import { getStateManager } from '../core/index.js';
import { computeStrategy, STRATEGY_MIN_PRS, type StrategyResult } from '../core/strategy.js';

/**
 * On-demand strategy snapshot. Mirrors `StrategyOutputSchema` in
 * `formatters/json.ts` structurally — that schema uses `.passthrough()`
 * for forward compatibility on the JSON-validation surface, so its
 * inferred type carries an extra `unknown` index signature that does
 * not match `StrategyResult`. The command's TypeScript shape is the
 * exact structural form below.
 */
export interface StrategyCommandOutput {
  strategy: StrategyResult | null;
  message?: string;
}

/**
 * Compute the on-demand strategy snapshot. Returns `{ strategy: null,
 * message }` when state is below the merged-PR floor, and `{ strategy }`
 * with the full typed result otherwise.
 */
export async function runStrategy(): Promise<StrategyCommandOutput> {
  const stateManager = getStateManager();
  const state = stateManager.getState();
  const strategy = computeStrategy(state);
  if (strategy === null) {
    const merged = state.mergedPRs?.length ?? 0;
    return {
      strategy: null,
      message:
        `Strategy snapshot needs at least ${STRATEGY_MIN_PRS} merged PRs in local state; ` +
        `currently tracking ${merged}. Keep contributing and the snapshot becomes available automatically.`,
    };
  }
  return { strategy };
}
