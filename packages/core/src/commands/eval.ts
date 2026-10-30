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

export async function runEval(): Promise<EvalOutput> {
  const report = computeEvalReport(getStateManager().getState());
  return { report, markdown: formatEvalMarkdown(report) };
}
