import { describe, it, expect } from 'vitest';
import { isBelowMinStars } from './types.js';

describe('isBelowMinStars', () => {
  it('returns true when stargazersCount is undefined', () => {
    expect(isBelowMinStars(undefined, 50)).toBe(true);
  });

  it('returns true when stargazersCount is below threshold', () => {
    expect(isBelowMinStars(10, 50)).toBe(true);
  });

  it('returns true when stargazersCount is zero', () => {
    expect(isBelowMinStars(0, 50)).toBe(true);
  });

  it('returns false when stargazersCount equals threshold', () => {
    expect(isBelowMinStars(50, 50)).toBe(false);
  });

  it('returns false when stargazersCount exceeds threshold', () => {
    expect(isBelowMinStars(100, 50)).toBe(false);
  });

  it('returns false when threshold is zero and stars are zero', () => {
    expect(isBelowMinStars(0, 0)).toBe(false);
  });
});
