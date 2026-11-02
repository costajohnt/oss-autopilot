/**
 * Rules over work claims (#1856, #1852 gap 2): expiry, the implementation
 * cap, one implementation per checkout, and how a claim shows up in vetting.
 */

import { describe, it, expect } from 'vitest';
import type { WorkClaim } from './state-schema.js';
import {
  activeWorkClaims,
  checkImplementationClaim,
  describeWorkClaim,
  findWorkClaim,
  finishedImplementations,
  isWorkClaimActive,
  normalizeWorktreePath,
  runningImplementations,
  workClaimAge,
  workClaimKey,
  workClaimVetFields,
} from './work-claims.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const HOUR = 3_600_000;
const ISSUE_A = 'https://github.com/owner/repo/issues/1';
const ISSUE_B = 'https://github.com/owner/repo/issues/2';
const ISSUE_C = 'https://github.com/owner/repo/issues/3';
const PR_URL = 'https://github.com/owner/repo/pull/9';

/** ISO timestamp `offsetMs` from NOW. */
function iso(offsetMs: number): string {
  const at = new Date(NOW + offsetMs);
  return at.toISOString();
}

const JUST_EXPIRED = iso(-1);

function claim(overrides: Partial<WorkClaim> = {}): WorkClaim {
  return {
    kind: 'implementation',
    url: ISSUE_A,
    session: 'air/1200',
    startedAt: iso(-HOUR),
    expiresAt: iso(23 * HOUR),
    status: 'running',
    worktree: '/work/wt/a',
    ...overrides,
  };
}

const EXPIRED_A = claim({ expiresAt: JUST_EXPIRED });

describe('isWorkClaimActive / activeWorkClaims', () => {
  it('treats a claim as live until expiresAt and expired from then on', () => {
    const live = claim({ expiresAt: iso(1) });
    expect(isWorkClaimActive(live, NOW)).toBe(true);
    expect(isWorkClaimActive(live, NOW + 1)).toBe(false);
  });

  it('treats an unparseable expiresAt as expired', () => {
    expect(isWorkClaimActive(claim({ expiresAt: 'not a date' }), NOW)).toBe(false);
  });

  it('keeps only live claims, in stored order', () => {
    const expired = claim({ url: ISSUE_B, expiresAt: JUST_EXPIRED });
    const first = claim();
    const last = claim({ url: ISSUE_C });
    expect(activeWorkClaims([first, expired, last], NOW)).toEqual([first, last]);
  });
});

describe('workClaimKey / findWorkClaim', () => {
  it('matches the same issue through case and a trailing slash', () => {
    expect(workClaimKey('https://github.com/Owner/Repo/issues/1/')).toBe(workClaimKey(ISSUE_A));
    expect(findWorkClaim([claim()], 'https://github.com/OWNER/repo/issues/1', NOW)?.session).toBe('air/1200');
  });

  it('falls back to the lowercased raw URL when the URL does not parse', () => {
    expect(workClaimKey(' https://example.com/X ')).toBe('https://example.com/x');
  });

  it('does not find an expired claim', () => {
    expect(findWorkClaim([EXPIRED_A], ISSUE_A, NOW)).toBeUndefined();
  });
});

describe('finishedImplementations / runningImplementations', () => {
  it('partitions live implementation claims by status and leaves pr claims out', () => {
    const running = claim();
    const finished = claim({ url: ISSUE_B, status: 'finished', worktree: '/work/wt/b' });
    const pr = claim({ kind: 'pr', url: PR_URL, status: 'running', worktree: undefined });
    const gone = claim({ url: ISSUE_C, status: 'finished', expiresAt: JUST_EXPIRED });
    expect(finishedImplementations([running, finished, pr, gone], NOW)).toEqual([finished]);
    expect(runningImplementations([running, finished, pr, gone], NOW)).toEqual([running]);
  });
});

describe('normalizeWorktreePath', () => {
  it('resolves the path and strips trailing separators', () => {
    expect(normalizeWorktreePath('/work/wt/a/')).toBe('/work/wt/a');
    expect(normalizeWorktreePath('/work/wt/../wt/a')).toBe('/work/wt/a');
    expect(normalizeWorktreePath(' /work/wt/a ')).toBe('/work/wt/a');
    expect(normalizeWorktreePath('/')).toBe('/');
  });
});

describe('checkImplementationClaim', () => {
  it('allows a claim under the cap in a free checkout', () => {
    expect(checkImplementationClaim([claim()], { url: ISSUE_B, worktree: '/work/wt/b' }, 2, NOW)).toBeNull();
  });

  it('refuses once the running implementations reach the cap, naming them', () => {
    const claims = [claim(), claim({ url: ISSUE_B, session: 'worker/7', worktree: undefined, runId: 'run-7' })];
    const conflict = checkImplementationClaim(claims, { url: ISSUE_C, worktree: '/work/wt/c' }, 2, NOW);
    expect(conflict?.reason).toBe('cap');
    expect(conflict?.blocking.map((c) => c.url)).toEqual([ISSUE_A, ISSUE_B]);
    expect(conflict?.message).toContain('2 of 2 running');
    expect(conflict?.message).toContain('session worker/7');
    expect(conflict?.message).toContain('maxConcurrentImplementations');
  });

  it('counts only running implementations toward the cap', () => {
    const claims = [claim(), claim({ url: ISSUE_B, status: 'finished', worktree: '/work/wt/b' })];
    expect(checkImplementationClaim(claims, { url: ISSUE_C, worktree: '/work/wt/c' }, 2, NOW)).toBeNull();
  });

  it('ignores expired claims and pr claims when counting', () => {
    const claims = [EXPIRED_A, claim({ kind: 'pr', url: PR_URL, worktree: undefined })];
    expect(checkImplementationClaim(claims, { url: ISSUE_C, worktree: '/work/wt/a' }, 1, NOW)).toBeNull();
  });

  it('a cap of 0 means no cap', () => {
    const claims = [claim(), claim({ url: ISSUE_B, worktree: '/work/wt/b' })];
    expect(checkImplementationClaim(claims, { url: ISSUE_C, worktree: '/work/wt/c' }, 0, NOW)).toBeNull();
  });

  it('refuses a second implementation in the same checkout, even when finished and under the cap', () => {
    const claims = [claim({ status: 'finished' })];
    const conflict = checkImplementationClaim(claims, { url: ISSUE_B, worktree: '/work/wt/a/' }, 5, NOW);
    expect(conflict?.reason).toBe('worktree');
    expect(conflict?.blocking).toEqual(claims);
    expect(conflict?.message).toContain('/work/wt/a already hosts an implementation of ' + ISSUE_A);
  });

  it('lets a claim on the same item renew itself in its own checkout and past the cap', () => {
    const claims = [claim(), claim({ url: ISSUE_B, worktree: '/work/wt/b' })];
    const spelledDifferently = 'https://github.com/OWNER/REPO/issues/1';
    expect(checkImplementationClaim(claims, { url: spelledDifferently, worktree: '/work/wt/a' }, 2, NOW)).toBeNull();
  });

  it('reports the checkout conflict before the cap', () => {
    const claims = [claim(), claim({ url: ISSUE_B, worktree: '/work/wt/b' })];
    const conflict = checkImplementationClaim(claims, { url: ISSUE_C, worktree: '/work/wt/b' }, 2, NOW);
    expect(conflict?.reason).toBe('worktree');
  });
});

describe('workClaimAge / describeWorkClaim', () => {
  it('renders minutes, hours and days', () => {
    expect(workClaimAge({ startedAt: iso(-12 * 60_000) }, NOW)).toBe('12 min');
    expect(workClaimAge({ startedAt: iso(-3 * HOUR) }, NOW)).toBe('3 h');
    expect(workClaimAge({ startedAt: iso(-50 * HOUR) }, NOW)).toBe('2 d');
    expect(workClaimAge({ startedAt: iso(HOUR) }, NOW)).toBe('0 min');
    expect(workClaimAge({ startedAt: 'garbage' }, NOW)).toBe('0 min');
  });

  it('names the kind, session, age and status', () => {
    expect(describeWorkClaim(claim(), NOW)).toBe('implementation claimed in session air/1200 (1 h, running)');
  });
});

describe('workClaimVetFields', () => {
  it('turns a live implementation claim into a skip with a reason naming the session', () => {
    const fields = workClaimVetFields([claim()], ISSUE_A, NOW);
    expect(fields?.recommendation).toBe('skip');
    expect(fields?.workClaim.url).toBe(ISSUE_A);
    // The word "claimed" is what vet-list's classifier keys on.
    expect(fields?.reasonsToSkip).toEqual([
      'Already being implemented: implementation claimed in session air/1200 (1 h, running)',
    ]);
  });

  it('returns null for an unclaimed issue, an expired claim, or a pr claim', () => {
    const prClaim = claim({ kind: 'pr', url: PR_URL });
    expect(workClaimVetFields([claim()], ISSUE_B, NOW)).toBeNull();
    expect(workClaimVetFields([EXPIRED_A], ISSUE_A, NOW)).toBeNull();
    expect(workClaimVetFields([prClaim], PR_URL, NOW)).toBeNull();
  });
});
