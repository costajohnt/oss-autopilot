/**
 * Detect formatters command (#703)
 * Scans a local repository for configured formatters/linters.
 * Optionally diagnoses CI log output for formatting failures.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DetectFormattersOutput } from '../formatters/json.js';
import { detectFormatters, diagnoseCIFormatterFailure } from '../core/formatter-detection.js';
import { errorMessage } from '../core/errors.js';

export type { DetectFormattersOutput };

export async function runDetectFormatters(options: {
  repoPath?: string;
  ciLog?: string;
}): Promise<DetectFormattersOutput> {
  const repoPath = path.resolve(options.repoPath ?? process.cwd());

  const output: DetectFormattersOutput = { ...detectFormatters(repoPath) };

  if (options.ciLog) {
    let logContent: string;
    try {
      logContent = fs.readFileSync(path.resolve(options.ciLog), 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read CI log file: ${errorMessage(err)}`, { cause: err });
    }
    output.ciDiagnosis = diagnoseCIFormatterFailure(logContent, repoPath);
  }

  return output;
}
