/**
 * Tests for ci-analysis.ts — CI check classification, analysis, and status merging.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyCICheck,
  classifyFailingChecks,
  analyzeCheckRuns,
  analyzeCombinedStatus,
  mergeStatuses,
} from './ci-analysis.js';

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

  it('should detect action_required as pending', () => {
    const result = analyzeCheckRuns([{ name: 'gate', conclusion: 'action_required', status: 'completed' }]);
    expect(result.hasPendingChecks).toBe(true);
    expect(result.hasFailingChecks).toBe(false);
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
    const failingCheckNames: string[] = [];
    const result = analyzeCombinedStatus(
      { state: 'failure', statuses: [{ state: 'failure', context: 'ci/test', description: 'Tests failed' }] },
      failingCheckNames,
    );
    expect(result.effectiveCombinedState).toBe('failure');
    expect(failingCheckNames).toContain('ci/test');
  });

  it('should filter out authorization-gate statuses', () => {
    const failingCheckNames: string[] = [];
    const result = analyzeCombinedStatus(
      {
        state: 'failure',
        statuses: [{ state: 'failure', context: 'vercel', description: 'Authorization required to deploy' }],
      },
      failingCheckNames,
    );
    expect(result.effectiveCombinedState).toBe('success');
    expect(failingCheckNames).toHaveLength(0);
  });

  it('should detect pending statuses', () => {
    const failingCheckNames: string[] = [];
    const result = analyzeCombinedStatus(
      { state: 'pending', statuses: [{ state: 'pending', context: 'ci/test', description: null }] },
      failingCheckNames,
    );
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
      { effectiveCombinedState: 'success', hasStatuses: true },
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
      { effectiveCombinedState: 'success', hasStatuses: true },
      1,
    );
    expect(result.status).toBe('pending');
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
      { effectiveCombinedState: 'success', hasStatuses: true },
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
      { effectiveCombinedState: 'neutral', hasStatuses: false },
      0,
    );
    expect(result.status).toBe('unknown');
  });
});
