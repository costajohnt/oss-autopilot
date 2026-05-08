/**
 * Tests for workflow-state helpers (#1280).
 */

import { describe, it, expect } from 'vitest';
import {
  recordWorkflowPause,
  getWorkflowState,
  clearWorkflowState,
  advanceWorkflowStep,
  setStepData,
  getStepData,
  isPausedIn,
} from './workflow-state.js';
import { AgentStateSchema } from './state-schema.js';
import type { AgentState } from './state-schema.js';

function emptyState(): AgentState {
  return AgentStateSchema.parse({ version: 4 });
}

const FIXED_NOW = new Date('2026-05-08T10:00:00.000Z');

describe('recordWorkflowPause / getWorkflowState', () => {
  it('persists the snapshot and round-trips through the schema', () => {
    const next = recordWorkflowPause(
      emptyState(),
      {
        workflowName: 'draft-first',
        currentStep: 'step_5_manual_testing',
        branchName: 'fix/issue-123',
        completedSteps: ['step_1a', 'step_1b'],
        stepData: { step_1d: { skipped: ['tests'] } },
      },
      FIXED_NOW,
    );
    const ws = getWorkflowState(next);
    expect(ws?.currentStep).toBe('step_5_manual_testing');
    expect(ws?.workflowName).toBe('draft-first');
    expect(ws?.lastUpdatedAt).toBe(FIXED_NOW.toISOString());
  });

  it('returns null when no pause is recorded', () => {
    expect(getWorkflowState(emptyState())).toBeNull();
  });

  it('does not mutate the input state', () => {
    const before = emptyState();
    recordWorkflowPause(
      before,
      {
        workflowName: 'work-through-issues',
        currentStep: 'pick_issue',
        completedSteps: [],
        stepData: {},
      },
      FIXED_NOW,
    );
    expect(before.workflowState).toBeUndefined();
  });
});

describe('clearWorkflowState', () => {
  it('removes the snapshot when present', () => {
    const paused = recordWorkflowPause(
      emptyState(),
      { workflowName: 'draft-first', currentStep: 'a', completedSteps: [], stepData: {} },
      FIXED_NOW,
    );
    expect(clearWorkflowState(paused).workflowState).toBeUndefined();
  });

  it('is a no-op when no snapshot exists', () => {
    const before = emptyState();
    expect(clearWorkflowState(before)).toBe(before);
  });
});

describe('advanceWorkflowStep', () => {
  it('appends the current step to completedSteps and moves to the next', () => {
    const paused = recordWorkflowPause(
      emptyState(),
      {
        workflowName: 'draft-first',
        currentStep: 'step_1a',
        completedSteps: [],
        stepData: {},
      },
      FIXED_NOW,
    );
    const advanced = advanceWorkflowStep(paused, 'step_1b');
    expect(advanced.workflowState?.currentStep).toBe('step_1b');
    expect(advanced.workflowState?.completedSteps).toEqual(['step_1a']);
  });

  it('does not duplicate the current step when it is already in completedSteps', () => {
    const paused = recordWorkflowPause(
      emptyState(),
      {
        workflowName: 'draft-first',
        currentStep: 'step_1a',
        completedSteps: ['step_1a'],
        stepData: {},
      },
      FIXED_NOW,
    );
    const advanced = advanceWorkflowStep(paused, 'step_1b');
    expect(advanced.workflowState?.completedSteps).toEqual(['step_1a']);
  });

  it('returns the same state when next === current', () => {
    const paused = recordWorkflowPause(
      emptyState(),
      {
        workflowName: 'draft-first',
        currentStep: 'step_1a',
        completedSteps: [],
        stepData: {},
      },
      FIXED_NOW,
    );
    expect(advanceWorkflowStep(paused, 'step_1a')).toBe(paused);
  });

  it('is a no-op when no snapshot exists', () => {
    const before = emptyState();
    expect(advanceWorkflowStep(before, 'step_x')).toBe(before);
  });
});

describe('setStepData / getStepData', () => {
  it('round-trips arbitrary JSON-shaped data per step', () => {
    let s = recordWorkflowPause(
      emptyState(),
      { workflowName: 'draft-first', currentStep: 'a', completedSteps: [], stepData: {} },
      FIXED_NOW,
    );
    s = setStepData(s, 'step_3', { lastReviewPass: 2, agentsWithFindings: ['code-reviewer'] });
    const got = getStepData(s, 'step_3') as { lastReviewPass: number };
    expect(got.lastReviewPass).toBe(2);
  });

  it('does not overwrite other steps when setting one', () => {
    let s = recordWorkflowPause(
      emptyState(),
      {
        workflowName: 'draft-first',
        currentStep: 'a',
        completedSteps: [],
        stepData: { step_1d: { skipped: ['tests'] } },
      },
      FIXED_NOW,
    );
    s = setStepData(s, 'step_3', { lastReviewPass: 2 });
    expect(getStepData(s, 'step_1d')).toEqual({ skipped: ['tests'] });
    expect(getStepData(s, 'step_3')).toEqual({ lastReviewPass: 2 });
  });

  it('returns undefined for unknown steps', () => {
    const s = recordWorkflowPause(
      emptyState(),
      { workflowName: 'draft-first', currentStep: 'a', completedSteps: [], stepData: {} },
      FIXED_NOW,
    );
    expect(getStepData(s, 'unknown')).toBeUndefined();
  });
});

describe('isPausedIn', () => {
  it('returns true when the snapshot matches the supplied workflow', () => {
    const paused = recordWorkflowPause(
      emptyState(),
      { workflowName: 'work-through-issues', currentStep: 'a', completedSteps: [], stepData: {} },
      FIXED_NOW,
    );
    expect(isPausedIn(paused, 'work-through-issues')).toBe(true);
    expect(isPausedIn(paused, 'draft-first')).toBe(false);
  });

  it('returns false when no snapshot exists', () => {
    expect(isPausedIn(emptyState(), 'draft-first')).toBe(false);
  });
});
