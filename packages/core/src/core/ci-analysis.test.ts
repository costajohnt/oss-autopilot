/**
 * Tests for ci-analysis.ts — CI check classification, analysis, and status merging.
 */

import { describe, it, expect } from 'vitest';
import {
  categorizeCIStatus,
  classifyCICheck,
  classifyFailingChecks,
  analyzeCheckRuns,
  analyzeCombinedStatus,
  mergeStatuses,
} from './ci-analysis.js';
import type { ClassifiedCheck } from './types.js';

describe('classifyCICheck', () => {
  it('should return "actionable" for unknown check names', () => {
    expect(classifyCICheck('unit-tests')).toBe('actionable');
    expect(classifyCICheck('lint')).toBe('actionable');
    expect(classifyCICheck('build')).toBe('actionable');
  });

  it('should classify cancelled conclusion as infrastructure', () => {
    expect(classifyCICheck('any-check', undefined, 'cancelled')).toBe('infrastructure');
  });

  it('should classify timed_out conclusion as infrastructure', () => {
    expect(classifyCICheck('any-check', undefined, 'timed_out')).toBe('infrastructure');
  });

  it('should classify Vercel as fork_limitation', () => {
    expect(classifyCICheck('Vercel – my-app')).toBe('fork_limitation');
  });

  it('should classify authorization-gate patterns as auth_gate', () => {
    expect(classifyCICheck('Authorization Check')).toBe('auth_gate');
    expect(classifyCICheck('CLA check')).toBe('auth_gate');
    expect(classifyCICheck('license/cla')).toBe('auth_gate');
  });

  it('should classify infrastructure patterns by name', () => {
    expect(classifyCICheck('Install Dependencies')).toBe('infrastructure');
    expect(classifyCICheck('Setup Failure')).toBe('infrastructure');
  });

  it('should classify "internal" CI checks as fork_limitation (#675)', () => {
    expect(classifyCICheck('Facebook Internal - Linter')).toBe('fork_limitation');
    expect(classifyCICheck('Meta Internal')).toBe('fork_limitation');
  });

  // #1057 M34 — the plain `\binternal\b` pattern was too broad and would
  // misclassify test-family checks named "Internal X Tests" as fork
  // limitations. Tightened pattern excludes a small set of test-descriptor
  // qualifiers so these are still treated as real CI.
  it('should NOT classify "internal <test-type>" checks as fork_limitation', () => {
    expect(classifyCICheck('Internal API Tests')).not.toBe('fork_limitation');
    expect(classifyCICheck('Internal Integration Tests')).not.toBe('fork_limitation');
    expect(classifyCICheck('Internal Unit Tests')).not.toBe('fork_limitation');
    expect(classifyCICheck('Internal E2E')).not.toBe('fork_limitation');
    expect(classifyCICheck('Internal Regression')).not.toBe('fork_limitation');
  });

  it('should classify Blacksmith CI runners as infrastructure (#675)', () => {
    expect(classifyCICheck('Playwright Tests (blacksmith-8vcpu-ubuntu, beta)')).toBe('infrastructure');
    expect(classifyCICheck('Blacksmith / build')).toBe('infrastructure');
  });

  it('should classify action_required conclusion as auth_gate (#743)', () => {
    expect(classifyCICheck('some-workflow', undefined, 'action_required')).toBe('auth_gate');
  });

  it('should prefer action_required conclusion over name-based classification (#743)', () => {
    expect(classifyCICheck('Vercel Deploy', undefined, 'action_required')).toBe('auth_gate');
  });

  it('should classify ReadTheDocs as infrastructure (#743)', () => {
    expect(classifyCICheck('readthedocs/build')).toBe('infrastructure');
    expect(classifyCICheck('ReadTheDocs Preview')).toBe('infrastructure');
  });

  it('should fall back to description when name is not classified', () => {
    expect(classifyCICheck('some-check', 'Authorization required')).toBe('auth_gate');
    expect(classifyCICheck('some-check', 'Vercel deployment')).toBe('fork_limitation');
  });

  it('should prefer name classification over description', () => {
    expect(classifyCICheck('CLA check', 'Vercel deploy')).toBe('auth_gate');
  });
});

describe('classifyFailingChecks', () => {
  it('should classify each failing check by name', () => {
    const result = classifyFailingChecks(['unit-tests', 'Vercel', 'CLA check']);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: 'unit-tests', category: 'actionable', conclusion: undefined });
    expect(result[1]).toEqual({ name: 'Vercel', category: 'fork_limitation', conclusion: undefined });
    expect(result[2]).toEqual({ name: 'CLA check', category: 'auth_gate', conclusion: undefined });
  });

  it('should use conclusions map when provided', () => {
    const conclusions = new Map([['build', 'cancelled']]);
    const result = classifyFailingChecks(['build'], conclusions);
    expect(result[0]).toEqual({ name: 'build', category: 'infrastructure', conclusion: 'cancelled' });
  });

  it('should classify action_required conclusion as auth_gate (#743)', () => {
    const conclusions = new Map([['gate', 'action_required']]);
    const result = classifyFailingChecks(['gate'], conclusions);
    expect(result[0]).toEqual({ name: 'gate', category: 'auth_gate', conclusion: 'action_required' });
  });

  it('should handle empty array', () => {
    expect(classifyFailingChecks([])).toEqual([]);
  });
});

describe('analyzeCheckRuns', () => {
  it('should detect failing checks', () => {
    const result = analyzeCheckRuns([{ name: 'test', conclusion: 'failure', status: 'completed' }]);
    expect(result.hasFailingChecks).toBe(true);
    expect(result.failingCheckNames).toEqual(['test']);
  });

  it('should detect pending checks (in_progress)', () => {
    const result = analyzeCheckRuns([{ name: 'lint', conclusion: null, status: 'in_progress' }]);
    expect(result.hasPendingChecks).toBe(true);
    expect(result.hasFailingChecks).toBe(false);
  });

  it('should detect action_required as failing (#743)', () => {
    const result = analyzeCheckRuns([{ name: 'gate', conclusion: 'action_required', status: 'completed' }]);
    expect(result.hasFailingChecks).toBe(true);
    expect(result.hasPendingChecks).toBe(false);
    expect(result.failingCheckNames).toEqual(['gate']);
    expect(result.failingCheckConclusions.get('gate')).toBe('action_required');
  });

  it('should handle mixed action_required and successful checks (#743)', () => {
    const result = analyzeCheckRuns([
      { name: 'gate', conclusion: 'action_required', status: 'completed' },
      { name: 'lint', conclusion: 'success', status: 'completed' },
    ]);
    expect(result.hasFailingChecks).toBe(true);
    expect(result.hasSuccessfulChecks).toBe(true);
    expect(result.failingCheckNames).toEqual(['gate']);
  });

  it('should handle mixed action_required and real failure checks (#743)', () => {
    const result = analyzeCheckRuns([
      { name: 'gate', conclusion: 'action_required', status: 'completed' },
      { name: 'tests', conclusion: 'failure', status: 'completed' },
    ]);
    expect(result.hasFailingChecks).toBe(true);
    expect(result.failingCheckNames).toEqual(['gate', 'tests']);
    const classified = classifyFailingChecks(result.failingCheckNames, result.failingCheckConclusions);
    expect(classified.find((c) => c.name === 'gate')?.category).toBe('auth_gate');
    expect(classified.find((c) => c.name === 'tests')?.category).toBe('actionable');
  });

  it('should detect successful checks', () => {
    const result = analyzeCheckRuns([{ name: 'test', conclusion: 'success', status: 'completed' }]);
    expect(result.hasSuccessfulChecks).toBe(true);
    expect(result.hasFailingChecks).toBe(false);
  });

  it('should handle empty check runs array', () => {
    const result = analyzeCheckRuns([]);
    expect(result.hasFailingChecks).toBe(false);
    expect(result.hasPendingChecks).toBe(false);
    expect(result.hasSuccessfulChecks).toBe(false);
  });
});

describe('analyzeCombinedStatus', () => {
  it('should detect real failures', () => {
    const result = analyzeCombinedStatus({
      state: 'failure',
      statuses: [{ state: 'failure', context: 'ci/test', description: 'Tests failed' }],
    });
    expect(result.effectiveCombinedState).toBe('failure');
    expect(result.failingStatusNames).toContain('ci/test');
  });

  it('should filter out authorization-gate statuses', () => {
    const result = analyzeCombinedStatus({
      state: 'failure',
      statuses: [{ state: 'failure', context: 'vercel', description: 'Authorization required to deploy' }],
    });
    expect(result.effectiveCombinedState).toBe('success');
    expect(result.failingStatusNames).toHaveLength(0);
  });

  it('should detect pending statuses', () => {
    const result = analyzeCombinedStatus({
      state: 'pending',
      statuses: [{ state: 'pending', context: 'ci/test', description: null }],
    });
    expect(result.effectiveCombinedState).toBe('pending');
  });
});

describe('mergeStatuses', () => {
  it('should return failing when check runs have failures', () => {
    const result = mergeStatuses(
      {
        hasFailingChecks: true,
        hasPendingChecks: false,
        hasSuccessfulChecks: false,
        failingCheckNames: ['test'],
        failingCheckConclusions: new Map([['test', 'failure']]),
      },
      { effectiveCombinedState: 'success', hasStatuses: true, failingStatusNames: [] },
      1,
    );
    expect(result.status).toBe('failing');
  });

  it('should return pending when checks are pending', () => {
    const result = mergeStatuses(
      {
        hasFailingChecks: false,
        hasPendingChecks: true,
        hasSuccessfulChecks: false,
        failingCheckNames: [],
        failingCheckConclusions: new Map(),
      },
      { effectiveCombinedState: 'success', hasStatuses: true, failingStatusNames: [] },
      1,
    );
    expect(result.status).toBe('pending');
  });

  it('should report failing with action_required conclusions preserved (#743)', () => {
    const result = mergeStatuses(
      {
        hasFailingChecks: true,
        hasPendingChecks: false,
        hasSuccessfulChecks: true,
        failingCheckNames: ['gate'],
        failingCheckConclusions: new Map([['gate', 'action_required']]),
      },
      { effectiveCombinedState: 'success', hasStatuses: false, failingStatusNames: [] },
      2,
    );
    expect(result.status).toBe('failing');
    expect(result.failingCheckNames).toEqual(['gate']);
    expect(result.failingCheckConclusions.get('gate')).toBe('action_required');
  });

  it('should return passing when all checks succeed', () => {
    const result = mergeStatuses(
      {
        hasFailingChecks: false,
        hasPendingChecks: false,
        hasSuccessfulChecks: true,
        failingCheckNames: [],
        failingCheckConclusions: new Map(),
      },
      { effectiveCombinedState: 'success', hasStatuses: true, failingStatusNames: [] },
      1,
    );
    expect(result.status).toBe('passing');
  });

  it('should return unknown when no checks and no statuses found at all', () => {
    // When effectiveCombinedState is not success/failure/pending and there are no check runs,
    // the result is unknown. Note: in practice analyzeCombinedStatus returns 'success' for
    // empty statuses, so this tests the fallback path with a non-standard state.
    const result = mergeStatuses(
      {
        hasFailingChecks: false,
        hasPendingChecks: false,
        hasSuccessfulChecks: false,
        failingCheckNames: [],
        failingCheckConclusions: new Map(),
      },
      { effectiveCombinedState: 'neutral', hasStatuses: false, failingStatusNames: [] },
      0,
    );
    expect(result.status).toBe('unknown');
  });
});

describe('categorizeCIStatus (#1272)', () => {
  function actionable(name: string): ClassifiedCheck {
    return { name, category: 'actionable' };
  }
  function forkLimit(name: string): ClassifiedCheck {
    return { name, category: 'fork_limitation' };
  }
  function authGate(name: string): ClassifiedCheck {
    return { name, category: 'auth_gate' };
  }

  it('returns all_passing when ciStatus is passing', () => {
    const r = categorizeCIStatus({ ciStatus: 'passing', failingCheckNames: [], classifiedChecks: [] });
    expect(r.category).toBe('all_passing');
    expect(r.action).toBe('none');
    expect(r.summary).toMatch(/passing/i);
  });

  it('returns blocked when ciStatus is pending', () => {
    const r = categorizeCIStatus({ ciStatus: 'pending', failingCheckNames: [], classifiedChecks: [] });
    expect(r.category).toBe('blocked');
    expect(r.action).toBe('request_rerun');
  });

  it('returns blocked with count when pending with failing names known', () => {
    const r = categorizeCIStatus({
      ciStatus: 'pending',
      failingCheckNames: ['unit-tests', 'lint'],
      classifiedChecks: [actionable('unit-tests'), actionable('lint')],
    });
    expect(r.category).toBe('blocked');
    expect(r.summary).toMatch(/2/);
  });

  it('returns failing when at least one classified check is actionable', () => {
    const r = categorizeCIStatus({
      ciStatus: 'failing',
      failingCheckNames: ['unit-tests', 'vercel-preview'],
      classifiedChecks: [actionable('unit-tests'), forkLimit('vercel-preview')],
    });
    expect(r.category).toBe('failing');
    expect(r.action).toBe('investigate');
    expect(r.summary).toMatch(/unit-tests/);
  });

  it('previews up to 3 actionable check names then summarizes the rest', () => {
    const r = categorizeCIStatus({
      ciStatus: 'failing',
      failingCheckNames: ['a', 'b', 'c', 'd', 'e'],
      classifiedChecks: [actionable('a'), actionable('b'), actionable('c'), actionable('d'), actionable('e')],
    });
    expect(r.summary).toContain('a, b, c');
    expect(r.summary).toMatch(/\+2 more/);
  });

  it('returns fork_limitation when failures exist but none are actionable or infrastructure', () => {
    const r = categorizeCIStatus({
      ciStatus: 'failing',
      failingCheckNames: ['vercel-preview', 'codecov-auth'],
      classifiedChecks: [forkLimit('vercel-preview'), authGate('codecov-auth')],
    });
    expect(r.category).toBe('fork_limitation');
    expect(r.action).toBe('informational');
  });

  it('returns blocked w/ request_rerun when non-actionable failures include infrastructure (cancelled runner)', () => {
    // Without the infrastructure-aware branch, this fell into
    // fork_limitation with the misleading "fork limits / auth gates"
    // summary. A cancelled runner is genuinely worth a rerun, not a
    // shrug.
    const r = categorizeCIStatus({
      ciStatus: 'failing',
      failingCheckNames: ['integration-tests'],
      classifiedChecks: [{ name: 'integration-tests', category: 'infrastructure', conclusion: 'cancelled' }],
    });
    expect(r.category).toBe('blocked');
    expect(r.action).toBe('request_rerun');
    expect(r.summary).toMatch(/rerun/i);
  });

  it('returns blocked w/ request_rerun when failures mix infrastructure + auth_gate (no actionable)', () => {
    const r = categorizeCIStatus({
      ciStatus: 'failing',
      failingCheckNames: ['unit-tests', 'codecov-auth'],
      classifiedChecks: [
        { name: 'unit-tests', category: 'infrastructure', conclusion: 'timed_out' },
        authGate('codecov-auth'),
      ],
    });
    expect(r.category).toBe('blocked');
    expect(r.action).toBe('request_rerun');
  });

  it('returns failing w/ honest summary when ciStatus is failing but no checks were classified', () => {
    // Reachable when the legacy combined-status endpoint reports failure
    // without per-check detail. Asserting "0 non-actionable failure(s)
    // (fork limits / auth gates)" would be a confident lie.
    const r = categorizeCIStatus({
      ciStatus: 'failing',
      failingCheckNames: [],
      classifiedChecks: [],
    });
    expect(r.category).toBe('failing');
    expect(r.action).toBe('investigate');
    expect(r.summary).toMatch(/no check details/i);
  });

  it('returns not_running when ciStatus is unknown', () => {
    const r = categorizeCIStatus({ ciStatus: 'unknown', failingCheckNames: [], classifiedChecks: [] });
    expect(r.category).toBe('not_running');
    expect(r.action).toBe('check_workflows');
  });

  it('returns 5 mutually-exclusive categories — same input produces same output (deterministic)', () => {
    const input = {
      ciStatus: 'failing' as const,
      failingCheckNames: ['lint'],
      classifiedChecks: [actionable('lint')],
    };
    expect(categorizeCIStatus(input)).toEqual(categorizeCIStatus(input));
  });

  it('summary is short enough for inline rendering (under 120 chars)', () => {
    // Stress: 10 actionable failures with long names
    const longNames = Array.from({ length: 10 }, (_, i) => `very-long-check-name-${i}-with-extra-context`);
    const r = categorizeCIStatus({
      ciStatus: 'failing',
      failingCheckNames: longNames,
      classifiedChecks: longNames.map(actionable),
    });
    // The preview includes 3 names plus "(+7 more)" — verify the resulting
    // summary stays bounded enough for action-menu rendering.
    expect(r.summary.length).toBeLessThan(180);
  });
});
