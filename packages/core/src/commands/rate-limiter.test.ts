import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow requests under the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });

    expect(limiter.check()).toEqual({ allowed: true });
    expect(limiter.check()).toEqual({ allowed: true });
    expect(limiter.check()).toEqual({ allowed: true });
  });

  it('should reject requests over the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });

    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(true);

    const result = limiter.check();
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('should allow requests again after the window expires', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });

    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(10_001);

    expect(limiter.check().allowed).toBe(true);
  });

  it('should return correct retryAfterSeconds', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 30_000 });

    expect(limiter.check().allowed).toBe(true);

    // Advance 10 seconds into the window
    vi.advanceTimersByTime(10_000);

    const result = limiter.check();
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // Should be ~20 seconds remaining
      expect(result.retryAfterSeconds).toBe(20);
    }
  });

  it('should use a sliding window (oldest request expires first)', () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 10_000 });

    // Request at t=0
    expect(limiter.check().allowed).toBe(true);

    // Request at t=5s
    vi.advanceTimersByTime(5_000);
    expect(limiter.check().allowed).toBe(true);

    // Request at t=6s — should be rejected (2 in window)
    vi.advanceTimersByTime(1_000);
    expect(limiter.check().allowed).toBe(false);

    // Advance to t=10.001s — first request falls out of window
    vi.advanceTimersByTime(4_001);
    expect(limiter.check().allowed).toBe(true);
  });
});
