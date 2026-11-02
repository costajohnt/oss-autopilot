/**
 * The daily run's dismissed-issue filter against a REAL StateManager over a
 * temp dir (paths.js redirected, same harness as
 * dashboard-override-partition.test.ts). daily-orchestration.test.ts mocks
 * `undismissIssue`, so nothing there proves an auto-undismiss reaches disk;
 * this suite dismisses, resurfaces on a newer engaged reply, reloads state
 * from disk and checks the dismiss record is gone (#1862).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';

/** The per-test temp dir; hoisted so the paths.js mock factory can read it. */
const tmp = vi.hoisted(() => ({ dir: '' }));

vi.mock('../core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/paths.js')>();
  const dir = (): string => {
    if (!tmp.dir) throw new Error('tmp.dir not set');
    if (!fs.existsSync(tmp.dir)) fs.mkdirSync(tmp.dir, { recursive: true, mode: 0o700 });
    return tmp.dir;
  };
  return {
    ...actual,
    getDataDir: dir,
    getStatePath: () => path.join(dir(), 'state.json'),
    getBackupDir: () => {
      const backupDir = path.join(dir(), 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      return backupDir;
    },
    getLegacyStatePath: () => path.join(dir(), 'legacy-data', 'state.json'),
    getLegacyBackupDir: () => path.join(dir(), 'legacy-data', 'backups'),
  };
});

import { getStateManager, resetStateManager } from '../core/index.js';
import type { CommentedIssue } from '../core/types.js';
import type { DailyWarning } from '../formatters/json.js';
import { filterDismissedIssues } from './daily-dismiss-filter.js';

const ISSUE_URL = 'https://github.com/owner/repo/issues/13';
const DISMISSED_AT = '2026-01-15T00:00:00Z';

/** A community reply on a claimed issue, posted at `lastResponseAt`. */
function engagedReply(lastResponseAt: string): CommentedIssue {
  return {
    repo: 'owner/repo',
    number: 13,
    title: 'Issue the user is working on',
    url: ISSUE_URL,
    status: 'new_response',
    userLastCommentedAt: '2026-01-10T00:00:00Z',
    userLastCommentBody: 'I will take this',
    lastResponseAuthor: 'community-member',
    lastResponseBody: 'I would rather see a config key than a flag here.',
    labels: [],
    daysSinceUserComment: 5,
    isFromMaintainer: false,
    engagement: { reason: 'claim', since: '2026-01-10T00:00:00Z' },
    lastResponseAt,
  };
}

/** Drop the in-memory singleton and read state.json back, as the next run would. */
function reloadFromDisk() {
  resetStateManager();
  return getStateManager();
}

describe('filterDismissedIssues against a real StateManager (#1862)', () => {
  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-dismiss-filter-'));
    resetStateManager();
  });

  afterEach(() => {
    resetStateManager();
    fs.rmSync(tmp.dir, { recursive: true, force: true });
    tmp.dir = '';
  });

  it('resurfaces a dismissed engaged issue on a newer reply and persists the undismiss to disk', () => {
    const sm = getStateManager();
    sm.dismissIssue(ISSUE_URL, DISMISSED_AT);
    expect(reloadFromDisk().getIssueDismissedAt(ISSUE_URL)).toBe(DISMISSED_AT);

    const warnings: DailyWarning[] = [];
    const kept = filterDismissedIssues(getStateManager(), [engagedReply('2026-02-01T00:00:00Z')], warnings);

    expect(kept.map((i) => i.url)).toEqual([ISSUE_URL]);
    expect(warnings).toEqual([]);
    expect(reloadFromDisk().getIssueDismissedAt(ISSUE_URL)).toBeUndefined();
  });

  it('keeps a dismissed issue hidden, and its record on disk, when the reply predates the dismiss', () => {
    getStateManager().dismissIssue(ISSUE_URL, DISMISSED_AT);

    const warnings: DailyWarning[] = [];
    const kept = filterDismissedIssues(reloadFromDisk(), [engagedReply('2026-01-14T00:00:00Z')], warnings);

    expect(kept).toEqual([]);
    expect(warnings).toEqual([]);
    expect(reloadFromDisk().getIssueDismissedAt(ISSUE_URL)).toBe(DISMISSED_AT);
  });

  it('passes undismissed issues through untouched', () => {
    const warnings: DailyWarning[] = [];
    const issue = engagedReply('2026-02-01T00:00:00Z');

    expect(filterDismissedIssues(getStateManager(), [issue], warnings)).toEqual([issue]);
    expect(warnings).toEqual([]);
  });
});
