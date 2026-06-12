/**
 * Dashboard shelve partition vs status overrides (#1416).
 *
 * The CLI applies status overrides BEFORE partitioning (daily.ts), so a
 * dormant PR with a criticality-flipping override is partitioned on its
 * overridden status. The dashboard used to partition on RAW status and only
 * apply overrides to the `activePRs` payload afterwards, so the two surfaces
 * disagreed for exactly that PR class — violating the #1352 "headline counts
 * cannot diverge" contract.
 *
 * dashboard-server.test.ts mocks `applyStatusOverrides` as identity (which is
 * why no test caught the divergence), so this suite deliberately runs the
 * REAL override pipeline: a real StateManager over a temp dir (paths.js
 * redirected, same pattern as state-concurrency.test.ts) with overrides set
 * via `setStatusOverride`, through the real `applyStatusOverrides`.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let mockTmpDir = '';

vi.mock('../core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/paths.js')>();
  return {
    ...actual,
    getDataDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) {
        fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      }
      return mockTmpDir;
    },
    getStatePath: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) {
        fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      }
      return path.join(mockTmpDir, 'state.json');
    },
    getBackupDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      const backupDir = path.join(mockTmpDir, 'backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      }
      return backupDir;
    },
    getLegacyStatePath: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      return path.join(mockTmpDir, 'legacy-data', 'state.json');
    },
    getLegacyBackupDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      return path.join(mockTmpDir, 'legacy-data', 'backups');
    },
  };
});

import { getStateManager, resetStateManager, CRITICAL_STATUSES, toShelvedPRRef } from '../core/index.js';
import { buildDashboardJson } from './dashboard-server.js';
import { makeFetchedPR, makeDailyDigest } from '../core/test-utils.js';

const PR_URL = 'https://github.com/owner/repo/pull/7';

/** A dormant PR — the class where overrides survive (auto-clear needs new activity). */
function makeDormantPR(status: 'needs_addressing' | 'waiting_on_maintainer') {
  return makeFetchedPR({
    repo: 'owner/repo',
    number: 7,
    status,
    stalenessTier: 'dormant',
    daysSinceActivity: 40,
    updatedAt: '2026-05-01T00:00:00Z',
  });
}

describe('buildDashboardJson partitions on post-override status (#1416)', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-override-'));
    resetStateManager();
  });

  afterEach(() => {
    resetStateManager();
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('shelves a dormant PR whose override flips needs_addressing -> waiting_on_maintainer (CLI parity)', () => {
    const pr = makeDormantPR('needs_addressing');
    const sm = getStateManager();
    // lastActivityAt matches updatedAt so getStatusOverride does not auto-clear.
    sm.setStatusOverride(PR_URL, 'waiting_on_maintainer', pr.updatedAt);

    const digest = makeDailyDigest({
      openPRs: [pr],
      summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
    });
    const data = buildDashboardJson(digest, sm.getState(), [], [], []);

    // Same rule daily.ts applies post-override: dormant + non-critical => shelved.
    expect(data.shelvedPRUrls).toContain(PR_URL);
    expect(data.stats.activePRs).toBe(0);
    // The payload PR carries the overridden status and a non-headline bucket.
    expect(data.activePRs[0].status).toBe('waiting_on_maintainer');
    expect(data.activePRs[0].attentionBucket).not.toBe('needs_attention');
  });

  it('keeps active a dormant PR whose override flips waiting_on_maintainer -> needs_addressing (CLI parity)', () => {
    const pr = makeDormantPR('waiting_on_maintainer');
    const sm = getStateManager();
    sm.setStatusOverride(PR_URL, 'needs_addressing', pr.updatedAt);

    const digest = makeDailyDigest({
      openPRs: [pr],
      summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
    });
    const data = buildDashboardJson(digest, sm.getState(), [], [], []);

    // Same rule daily.ts applies post-override: critical is never shelved.
    expect(CRITICAL_STATUSES.has('needs_addressing')).toBe(true);
    expect(data.shelvedPRUrls).not.toContain(PR_URL);
    expect(data.stats.activePRs).toBe(1);
    // Post-override status reaches the attention classifier, so the PR shows
    // up in the headline bucket instead of vanishing into the shelf.
    expect(data.activePRs[0].status).toBe('needs_addressing');
    expect(data.activePRs[0].attentionBucket).toBe('needs_attention');
  });

  it('does not mutate the caller-owned cached digest', () => {
    const pr = makeDormantPR('waiting_on_maintainer');
    const sm = getStateManager();
    sm.setStatusOverride(PR_URL, 'needs_addressing', pr.updatedAt);

    const digest = makeDailyDigest({
      openPRs: [pr],
      summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
    });
    buildDashboardJson(digest, sm.getState(), [], [], []);

    // The cached digest the action path reuses must keep raw statuses and its
    // original partition; every request re-derives from current state.
    expect(digest.openPRs[0].status).toBe('waiting_on_maintainer');
    expect(digest.shelvedPRs).toEqual([]);
    expect(digest.summary.totalActivePRs).toBe(1);
  });

  it('drops a BAKED shelved ref when the override flips the PR critical (action-path flow)', () => {
    // The POST /api/action flow: the cached digest already carries the PR in
    // shelvedPRs, then runMove sets a criticality-flipping override. The
    // reconcile FILTER branch must drop the baked ref on rebuild.
    const pr = makeDormantPR('waiting_on_maintainer');
    const sm = getStateManager();
    sm.setStatusOverride(PR_URL, 'needs_addressing', pr.updatedAt);

    const digest = makeDailyDigest({
      openPRs: [pr],
      shelvedPRs: [toShelvedPRRef(pr)],
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
    });
    const data = buildDashboardJson(digest, sm.getState(), [], [], []);

    expect(data.shelvedPRUrls).not.toContain(PR_URL);
    expect(data.stats.activePRs).toBe(1);
  });

  it('unshelves an EXPLICITLY shelved PR when the override flips it critical (#1352 parity)', () => {
    // Not dormant — shelved purely via config.shelvedPRUrls. The critical
    // check must run on the post-override status for the explicit-shelve
    // branch too, matching the daily check's CRITICAL_STATUSES auto-unshelve.
    const pr = makeFetchedPR({
      repo: 'owner/repo',
      number: 7,
      status: 'waiting_on_maintainer',
      stalenessTier: 'active',
      updatedAt: '2026-05-01T00:00:00Z',
    });
    const sm = getStateManager();
    sm.shelvePR(PR_URL);
    sm.setStatusOverride(PR_URL, 'needs_addressing', pr.updatedAt);

    const digest = makeDailyDigest({
      openPRs: [pr],
      summary: { totalActivePRs: 1, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 0 },
    });
    const data = buildDashboardJson(digest, sm.getState(), [], [], []);

    expect(data.shelvedPRUrls).not.toContain(PR_URL);
    expect(data.stats.activePRs).toBe(1);
    expect(data.activePRs[0].attentionBucket).toBe('needs_attention');
  });

  it('partitions on RAW status once new activity auto-clears a stale override', () => {
    const pr = makeDormantPR('needs_addressing'); // updatedAt 2026-05-01
    const sm = getStateManager();
    // Override recorded against OLDER activity — getStatusOverride must
    // auto-clear it when it sees the newer updatedAt.
    sm.setStatusOverride(PR_URL, 'waiting_on_maintainer', '2026-04-01T00:00:00Z');

    const digest = makeDailyDigest({
      openPRs: [pr],
      summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
    });
    const data = buildDashboardJson(digest, sm.getState(), [], [], []);

    // Raw critical status wins: never shelved, headline bucket.
    expect(data.shelvedPRUrls).not.toContain(PR_URL);
    expect(data.activePRs[0].status).toBe('needs_addressing');
    // And the stale override is gone from state, same as the CLI path.
    expect(sm.getState().config.statusOverrides?.[PR_URL]).toBeUndefined();
  });

  it('clearing an override takes effect on the next rebuild of the same cached digest', () => {
    // Regression guard for the bake-in failure mode: digests cache RAW
    // statuses, so move target=auto (clearStatusOverride) must be visible on
    // the very next rebuild, not only after a full /api/refresh.
    const pr = makeDormantPR('needs_addressing');
    const sm = getStateManager();
    sm.setStatusOverride(PR_URL, 'waiting_on_maintainer', pr.updatedAt);

    const digest = makeDailyDigest({
      openPRs: [pr],
      summary: { totalActivePRs: 1, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
    });

    const before = buildDashboardJson(digest, sm.getState(), [], [], []);
    expect(before.shelvedPRUrls).toContain(PR_URL);
    expect(before.activePRs[0].status).toBe('waiting_on_maintainer');

    sm.clearStatusOverride(PR_URL);
    const after = buildDashboardJson(digest, sm.getState(), [], [], []);
    expect(after.shelvedPRUrls).not.toContain(PR_URL);
    expect(after.activePRs[0].status).toBe('needs_addressing');
    expect(after.activePRs[0].attentionBucket).toBe('needs_attention');
  });
});
