/**
 * Simple in-memory sliding-window rate limiter for the dashboard server.
 *
 * Each endpoint gets its own limiter with a configurable max number of
 * requests per time window. Returns 429 with Retry-After when exceeded.
 */

export interface RateLimiterConfig {
  /** Maximum requests allowed within the window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  /** Timestamps of accepted requests within the current window. */
  private timestamps: number[] = [];

  constructor(config: RateLimiterConfig) {
    this.maxRequests = config.maxRequests;
    this.windowMs = config.windowMs;
  }

  /**
   * Check if a request is allowed.
   *
   * @returns `{ allowed: true }` if under the limit, or
   *          `{ allowed: false, retryAfterSeconds }` if rate-limited.
   */
  check(): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Prune timestamps outside the current window
    this.timestamps = this.timestamps.filter((t) => t > windowStart);

    if (this.timestamps.length >= this.maxRequests) {
      // Earliest timestamp in window — client must wait until it expires
      const oldestInWindow = this.timestamps[0];
      const retryAfterMs = oldestInWindow + this.windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
    }

    this.timestamps.push(now);
    return { allowed: true };
  }
}
