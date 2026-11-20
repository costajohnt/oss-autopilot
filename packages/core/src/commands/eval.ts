/**
 * eval command (#1825): calibration and outcome metrics from the outcome
 * ledger. Local-only: reads state, never calls GitHub. Run `ledger-backfill`
 * first so historical entries carry close reasons and list vet scores.
 */

import { computeEvalReport, formatEvalMarkdown, type EvalReport } from '../core/eval-report.js';
import { getStateManager } from '../core/index.js';

export interface EvalOutput {
  report: EvalReport;
  markdown: string;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async keeps the Promise-returning contract callers rely on; the body has no await yet
export async function runEval(): Promise<EvalOutput> {
  const report = computeEvalReport(getStateManager().getState());
  return { report, markdown: formatEvalMarkdown(report) };
}
