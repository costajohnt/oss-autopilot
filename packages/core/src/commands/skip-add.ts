import * as fs from 'fs';
import { loadSkippedIssues } from './skip-file-parser.js';
import { getStateManager } from '../core/index.js';

// Keep in sync with GITHUB_URL_RE in skip-file-parser.ts.
const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/;

const FILE_HEADER = '# Skipped Issues — auto-culled after 90 days\n# Format: YYYY-MM-DD URL\n\n';

export interface SkipAddOptions {
  issueUrl: string;
  /** Override the configured `skippedIssuesPath`. */
  skipFilePath?: string;
  /** Injected for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

export interface SkipAddOutput {
  added: boolean;
  alreadyPresent: boolean;
  url: string;
  path: string;
  /** Populated only when an entry was appended. */
  date?: string;
}

function formatUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Append an issue URL to the skipped-issues file.
 *
 * Creates the file with the standard header if it doesn't exist. If the URL
 * is already present (per the skip-file-parser's view of the file), this is
 * a no-op and returns `alreadyPresent: true`.
 *
 * @throws when no path can be resolved or the URL isn't a GitHub issue/PR URL.
 */
export function runSkipAdd(options: SkipAddOptions): SkipAddOutput {
  const skipFilePath = options.skipFilePath ?? getStateManager().getState().config.skippedIssuesPath;

  if (!skipFilePath) {
    throw new Error(
      'No skipped-issues path configured. Set one via `oss-autopilot config --set skippedIssuesPath=<path>` or pass --path.',
    );
  }

  if (!GITHUB_URL_RE.test(options.issueUrl)) {
    throw new Error(`Invalid GitHub issue or PR URL: ${options.issueUrl}`);
  }

  const existing = loadSkippedIssues(skipFilePath);
  if (existing.some((entry) => entry.url === options.issueUrl)) {
    return {
      added: false,
      alreadyPresent: true,
      url: options.issueUrl,
      path: skipFilePath,
    };
  }

  if (!fs.existsSync(skipFilePath)) {
    fs.writeFileSync(skipFilePath, FILE_HEADER);
  }

  const date = formatUtcDate(options.now ?? new Date());
  fs.appendFileSync(skipFilePath, `${date} ${options.issueUrl}\n`);

  return {
    added: true,
    alreadyPresent: false,
    url: options.issueUrl,
    path: skipFilePath,
    date,
  };
}
