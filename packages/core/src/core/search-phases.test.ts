import { describe, it, expect } from 'vitest';
import { buildLabelQuery, buildEffectiveLabels, interleaveArrays, batchRepos } from './search-phases.js';
import { SCOPE_LABELS } from './types.js';

describe('buildLabelQuery', () => {
  it('returns empty string for no labels', () => {
    expect(buildLabelQuery([])).toBe('');
  });

  it('returns single label without OR wrapper', () => {
    expect(buildLabelQuery(['good first issue'])).toBe('label:"good first issue"');
  });

  it('returns OR-joined labels wrapped in parentheses', () => {
    const result = buildLabelQuery(['bug', 'enhancement']);
    expect(result).toBe('(label:"bug" OR label:"enhancement")');
  });

  it('handles three labels', () => {
    const result = buildLabelQuery(['a', 'b', 'c']);
    expect(result).toBe('(label:"a" OR label:"b" OR label:"c")');
  });
});

describe('buildEffectiveLabels', () => {
  it('should return scope labels for a single scope', () => {
    const result = buildEffectiveLabels(['beginner'], []);
    expect(result).toEqual(SCOPE_LABELS.beginner);
  });

  it('should merge labels from multiple scopes', () => {
    const result = buildEffectiveLabels(['beginner', 'intermediate'], []);
    for (const label of SCOPE_LABELS.beginner) {
      expect(result).toContain(label);
    }
    for (const label of SCOPE_LABELS.intermediate) {
      expect(result).toContain(label);
    }
  });

  it('should merge custom labels with scope labels', () => {
    const result = buildEffectiveLabels(['beginner'], ['custom-label']);
    expect(result).toContain('good first issue');
    expect(result).toContain('custom-label');
  });

  it('should deduplicate when custom labels overlap with scope labels', () => {
    const result = buildEffectiveLabels(['beginner'], ['good first issue', 'custom']);
    const gfiCount = result.filter((l) => l === 'good first issue').length;
    expect(gfiCount).toBe(1);
    expect(result).toContain('custom');
  });

  it('should return only custom labels when scopes is empty', () => {
    const result = buildEffectiveLabels([], ['my-label']);
    expect(result).toEqual(['my-label']);
  });
});

describe('interleaveArrays', () => {
  it('should interleave two equal-length arrays', () => {
    const result = interleaveArrays([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ]);
    expect(result).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  });

  it('should handle arrays of different lengths', () => {
    const result = interleaveArrays([
      ['a1', 'a2'],
      ['b1', 'b2', 'b3'],
    ]);
    expect(result).toEqual(['a1', 'b1', 'a2', 'b2', 'b3']);
  });

  it('should handle three arrays', () => {
    const result = interleaveArrays([['a1'], ['b1'], ['c1']]);
    expect(result).toEqual(['a1', 'b1', 'c1']);
  });

  it('should handle empty arrays', () => {
    expect(interleaveArrays([])).toEqual([]);
    expect(interleaveArrays([[], []])).toEqual([]);
  });

  it('should handle single array', () => {
    expect(interleaveArrays([['a', 'b']])).toEqual(['a', 'b']);
  });
});

describe('batchRepos', () => {
  it('splits repos into batches of specified size', () => {
    const result = batchRepos(['a', 'b', 'c', 'd', 'e'], 2);
    expect(result).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('returns single batch when repos fit', () => {
    const result = batchRepos(['a', 'b'], 5);
    expect(result).toEqual([['a', 'b']]);
  });

  it('returns empty array for empty input', () => {
    expect(batchRepos([], 5)).toEqual([]);
  });

  it('handles batch size of 1', () => {
    const result = batchRepos(['a', 'b', 'c'], 1);
    expect(result).toEqual([['a'], ['b'], ['c']]);
  });

  it('handles exact multiple of batch size', () => {
    const result = batchRepos(['a', 'b', 'c', 'd'], 2);
    expect(result).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});
