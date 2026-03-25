import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchBudgetTracker, getSearchBudgetTracker } from './search-budget.js';

vi.mock('./logger.js', () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('./utils.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

describe('SearchBudgetTracker', () => {
  let tracker: SearchBudgetTracker;

  beforeEach(() => {
    tracker = new SearchBudgetTracker();
  });

  it('starts with zero calls', () => {
    expect(tracker.getCallsInWindow()).toBe(0);
    expect(tracker.getTotalCalls()).toBe(0);
  });

  it('records calls and reports count', () => {
    tracker.recordCall();
    tracker.recordCall();
    tracker.recordCall();
    expect(tracker.getCallsInWindow()).toBe(3);
    expect(tracker.getTotalCalls()).toBe(3);
  });

  it('canAfford returns true when under budget', () => {
    expect(tracker.canAfford(5)).toBe(true);
    expect(tracker.canAfford(26)).toBe(true); // EFFECTIVE_BUDGET = 30 - 4 = 26
  });

  it('canAfford returns false when at budget', () => {
    // Fill up the budget (26 calls = EFFECTIVE_BUDGET)
    for (let i = 0; i < 26; i++) {
      tracker.recordCall();
    }
    expect(tracker.canAfford(1)).toBe(false);
  });

  it('init resets state', () => {
    tracker.recordCall();
    tracker.recordCall();
    expect(tracker.getTotalCalls()).toBe(2);

    tracker.init(25, new Date(Date.now() + 60000).toISOString());
    expect(tracker.getTotalCalls()).toBe(0);
    expect(tracker.getCallsInWindow()).toBe(0);
  });

  it('waitForBudget returns immediately when budget available', async () => {
    tracker.recordCall();
    await tracker.waitForBudget(); // should not throw or hang
    expect(tracker.getCallsInWindow()).toBe(1);
  });

  it('waitForBudget waits when budget is full', async () => {
    const { sleep } = await import('./utils.js');
    const realNow = Date.now();

    // Fill up the budget
    for (let i = 0; i < 26; i++) {
      tracker.recordCall();
    }

    // Mock sleep to advance Date.now by 61 seconds so timestamps age out of the window
    vi.mocked(sleep).mockImplementation(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
    });

    await tracker.waitForBudget();
    // Should have called sleep to wait for budget
    expect(sleep).toHaveBeenCalled();

    // Restore Date.now
    vi.restoreAllMocks();
  });

  it('canAfford respects external budget from init', () => {
    // When GitHub reports only 5 remaining, tracker should refuse after 5 calls
    tracker.init(5, new Date(Date.now() + 60000).toISOString());
    for (let i = 0; i < 5; i++) {
      expect(tracker.canAfford(1)).toBe(true);
      tracker.recordCall();
    }
    expect(tracker.canAfford(1)).toBe(false);
  });

  it('waitForBudget returns immediately when external budget exhausted but no local timestamps', async () => {
    // Edge case: init with 0 remaining but no local calls.
    // Should return immediately (no timestamps to wait on) rather than looping forever.
    tracker.init(0, new Date(Date.now() + 60000).toISOString());
    await tracker.waitForBudget(); // should not hang
  });
});

describe('getSearchBudgetTracker', () => {
  it('returns singleton instance', () => {
    const a = getSearchBudgetTracker();
    const b = getSearchBudgetTracker();
    expect(a).toBe(b);
  });
});
