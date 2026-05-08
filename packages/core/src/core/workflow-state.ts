/**
 * Workflow-state helpers (#1280).
 *
 * Centralizes the read/write logic for `state.workflowState`. Used
 * by `draft-first-workflow.md`, `work-through-issues.md`, and
 * `pre-commit-review.md` to record pause points and offer
 * Resume / Restart / Discard at the next `/oss` invocation.
 *
 * Pure functions — callers manage state I/O. Same architectural
 * shape as the recent #1277 (follow-up-history) helpers.
 */

import type { AgentState, WorkflowState } from './state-schema.js';

export type WorkflowName = WorkflowState['workflowName'];

/**
 * Snapshot the user's current workflow position. Returns the
 * patched state; callers persist via `StateManager.save()` (or the
 * gist `checkpoint()` path).
 */
export function recordWorkflowPause(
  state: AgentState,
  next: Omit<WorkflowState, 'lastUpdatedAt'>,
  now: Date = new Date(),
): AgentState {
  const incoming: WorkflowState = {
    ...next,
    lastUpdatedAt: now.toISOString(),
  };
  return { ...state, workflowState: incoming };
}

/**
 * Read the current workflow snapshot, or null when no pause is
 * recorded.
 */
export function getWorkflowState(state: AgentState): WorkflowState | null {
  return state.workflowState ?? null;
}

/**
 * Discard the current pause snapshot. Used by:
 *  - the workflow completing normally,
 *  - the user picking "Discard and start fresh" at the resume
 *    prompt,
 *  - any consumer that detects the snapshot has gone stale (branch
 *    deleted, repo no longer reachable).
 */
export function clearWorkflowState(state: AgentState): AgentState {
  if (!state.workflowState) return state;
  const { workflowState: _drop, ...rest } = state;
  return rest;
}

/**
 * Append a step name to `completedSteps` and update `currentStep`
 * to the supplied next step. Convenience wrapper around the immer-
 * style read/replace pattern. Returns the patched state.
 */
export function advanceWorkflowStep(state: AgentState, nextStep: string, now: Date = new Date()): AgentState {
  const ws = state.workflowState;
  if (!ws) return state;
  if (ws.currentStep === nextStep) return state;
  const completed = [...ws.completedSteps];
  if (!completed.includes(ws.currentStep)) completed.push(ws.currentStep);
  return {
    ...state,
    workflowState: {
      ...ws,
      currentStep: nextStep,
      completedSteps: completed,
      lastUpdatedAt: now.toISOString(),
    },
  };
}

/**
 * Merge per-step data into `stepData` without overwriting other
 * keys. Useful when a workflow's resume needs to restore non-trivial
 * context (skipped compliance items, last review pass count, etc.).
 */
export function setStepData(state: AgentState, step: string, data: unknown, now: Date = new Date()): AgentState {
  const ws = state.workflowState;
  if (!ws) return state;
  return {
    ...state,
    workflowState: {
      ...ws,
      stepData: { ...ws.stepData, [step]: data },
      lastUpdatedAt: now.toISOString(),
    },
  };
}

/**
 * Read step data for a specific step, or undefined when none was
 * stored. Callers typically narrow the unknown via a type guard.
 */
export function getStepData(state: AgentState, step: string): unknown {
  return state.workflowState?.stepData[step];
}

/**
 * Whether the recorded pause is on the supplied workflow. Useful
 * for the router to decide whether to offer Resume vs ignore the
 * snapshot when the current `/oss` invocation is unrelated.
 */
export function isPausedIn(state: AgentState, workflowName: WorkflowName): boolean {
  return state.workflowState?.workflowName === workflowName;
}
