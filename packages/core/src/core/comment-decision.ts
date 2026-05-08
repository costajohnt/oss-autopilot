/**
 * Post-push comment decision (#1286).
 *
 * Centralizes the "should I draft a comment, or does the diff speak
 * for itself?" rule that was duplicated between
 * `workflows/pre-commit-review.md` Step 7a and `agents/pr-responder.md`
 * Step 3.
 *
 * Pure typed helper — no LLM, no I/O. Callers do the upstream natural-
 * language classification (mapping a maintainer comment to a structured
 * `FeedbackCategory` + flags) and pass in the result. This module owns
 * the rule that decides skip vs. draft from the structured input.
 *
 * Same architectural shape as #1245 (compliance-score), #1242 (repo-vet),
 * #1243 (strategy), #1252 (pr-quality-rubric), and #1264 (issue-effort /
 * maintainer-hints).
 */

export type FeedbackCategory =
  | 'code_request'
  | 'question'
  | 'explanation_request'
  | 'style_request'
  | 'design_discussion'
  | 'approval_with_nit'
  | 'formatting_complaint';

export interface FeedbackClassification {
  category: FeedbackCategory;
  /**
   * Whether this individual feedback item, considered in isolation,
   * requires a drafted comment. Aggregated by `shouldDraftResponse`
   * across the full feedback list.
   */
  needsComment: boolean;
  /** Short rationale rendered alongside the decision. */
  reason: string;
}

export interface CommentDecisionInput {
  /**
   * Pre-classified feedback items in chronological order. The caller
   * (agent or workflow) is responsible for the natural-language
   * categorization step; this function only consumes structured input.
   */
  feedback: readonly FeedbackClassification[];
  /**
   * True when the contributor pushed code that addresses every
   * feedback item that requested a code change. The agent's diff
   * inspection determines this; the function trusts the boolean.
   */
  allRequestedChangesAddressed: boolean;
}

export interface CommentDecisionResult {
  shouldDraft: boolean;
  reason: string;
}

/**
 * Decide whether the contributor should draft a comment after a push.
 *
 * Rule (sourced verbatim from `workflows/pre-commit-review.md` Step 7a
 * and `agents/pr-responder.md` "Comment Decision Logic"):
 *
 *  - Skip the comment entirely when ALL of these are true:
 *    1. Every piece of maintainer feedback that requested code changes
 *       has a corresponding code change.
 *    2. No question was asked.
 *    3. Nothing was intentionally left unchanged (a "yes the maintainer
 *       asked but I did not change it" item always needs explanation).
 *    4. The diff makes the fix self-evident — modeled here as the
 *       `allRequestedChangesAddressed` flag the caller passes in.
 *
 *  - Draft a comment if ANY of these are true:
 *    1. The maintainer asked a question.
 *    2. The feedback is conceptual or design-level (the diff alone
 *       cannot answer "why").
 *    3. Something was intentionally left unchanged (`needsComment: true`
 *       on a code-request item where the contributor disagrees).
 *    4. Only some of multiple requested changes were addressed.
 *    5. The contributor deviated from exactly what was asked.
 */
export function shouldDraftResponse(input: CommentDecisionInput): CommentDecisionResult {
  if (input.feedback.length === 0) {
    return { shouldDraft: false, reason: 'no maintainer feedback to address' };
  }

  // Categories that always demand a written reply, regardless of the
  // diff. The diff cannot answer a question or carry a design decision.
  const alwaysDraftCategories = new Set<FeedbackCategory>(['question', 'explanation_request', 'design_discussion']);

  for (const item of input.feedback) {
    if (alwaysDraftCategories.has(item.category)) {
      return {
        shouldDraft: true,
        reason: `${item.category.replace(/_/g, ' ')} — diff alone cannot address this`,
      };
    }
  }

  // Caller flagged at least one item as "I'm intentionally not making
  // this change" or "I deviated" — needs an explanation either way.
  const intentionalGap = input.feedback.find((item) => item.needsComment);
  if (intentionalGap) {
    return {
      shouldDraft: true,
      reason: `requires written explanation: ${intentionalGap.reason}`,
    };
  }

  // Caller signaled the diff covers everything that was requested.
  if (input.allRequestedChangesAddressed) {
    return { shouldDraft: false, reason: 'all requested changes are visible in the diff' };
  }

  return {
    shouldDraft: true,
    reason: 'not all requested changes are visible in the diff yet',
  };
}
