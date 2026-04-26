import { describe, it, expect } from 'vitest';
import { GistStateStore } from './gist-state-store.js';
import {
  getGuidelines,
  setGuidelines,
  deleteGuidelines,
  listGuidelinesRepos,
  guidelinesFilename,
  repoFromGuidelinesFilename,
  GUIDELINES_FILE_PREFIX,
  GUIDELINES_MAX_BYTES,
  GuidelinesNotAvailableError,
  GuidelinesTooLargeError,
} from './guidelines-store.js';

/**
 * Build a minimally-valid GistStateStore stub via the public surface — we
 * only need the in-memory cache + dirty-tracking, not real network calls.
 *
 * The store's constructor takes an Octokit-like object; we pass a stub that
 * never gets called by any of the document operations (which are pure cache
 * mutations). The cast keeps TypeScript happy without polluting the public
 * `OctokitLike` shape with test-only fields.
 */
function makeStubStore(): GistStateStore {
  const stubOctokit = {
    gists: {
      get: () => Promise.reject(new Error('unused in cache-only tests')),
      list: () => Promise.reject(new Error('unused in cache-only tests')),
      create: () => Promise.reject(new Error('unused in cache-only tests')),
      update: () => Promise.reject(new Error('unused in cache-only tests')),
    },
  };
  return new GistStateStore(stubOctokit as unknown as ConstructorParameters<typeof GistStateStore>[0]);
}

describe('guidelinesFilename', () => {
  it('encodes owner/repo as guidelines--owner--repo.md', () => {
    expect(guidelinesFilename('costajohnt/oss-autopilot')).toBe('guidelines--costajohnt--oss-autopilot.md');
  });

  it('throws on a string without a slash', () => {
    expect(() => guidelinesFilename('justanowner')).toThrow(/Invalid repo identifier/);
  });
});

describe('repoFromGuidelinesFilename', () => {
  it('round-trips a standard filename', () => {
    expect(repoFromGuidelinesFilename('guidelines--costajohnt--oss-autopilot.md')).toBe('costajohnt/oss-autopilot');
  });

  it('returns null for a filename missing the prefix', () => {
    expect(repoFromGuidelinesFilename('state.json')).toBeNull();
  });

  it('returns null for a filename missing the .md suffix', () => {
    expect(repoFromGuidelinesFilename('guidelines--owner--repo')).toBeNull();
  });

  it('returns null for a filename with no double-dash separator', () => {
    expect(repoFromGuidelinesFilename('guidelines--owneronly.md')).toBeNull();
  });

  it('handles repo names that contain extra hyphens after the separator', () => {
    expect(repoFromGuidelinesFilename('guidelines--owner--repo-with-hyphens.md')).toBe('owner/repo-with-hyphens');
  });
});

describe('getGuidelines / setGuidelines / deleteGuidelines', () => {
  it('getGuidelines returns null when the store is null (local mode)', () => {
    expect(getGuidelines(null, 'owner/repo')).toBeNull();
  });

  it('getGuidelines returns null when the file does not exist in cache', () => {
    const store = makeStubStore();
    expect(getGuidelines(store, 'owner/repo')).toBeNull();
  });

  it('setGuidelines + getGuidelines round-trips content', () => {
    const store = makeStubStore();
    setGuidelines(store, 'owner/repo', '# Guidelines\n- rule 1');
    expect(getGuidelines(store, 'owner/repo')).toBe('# Guidelines\n- rule 1');
  });

  it('setGuidelines marks the file dirty so the next push includes it', () => {
    const store = makeStubStore();
    setGuidelines(store, 'owner/repo', 'x');
    expect(store.dirtyFiles.has(guidelinesFilename('owner/repo'))).toBe(true);
  });

  it('setGuidelines throws GuidelinesNotAvailableError when store is null', () => {
    expect(() => setGuidelines(null, 'owner/repo', 'x')).toThrow(GuidelinesNotAvailableError);
  });

  it('setGuidelines throws GuidelinesTooLargeError when content exceeds the byte cap', () => {
    const store = makeStubStore();
    const oversized = 'x'.repeat(GUIDELINES_MAX_BYTES + 1);
    expect(() => setGuidelines(store, 'owner/repo', oversized)).toThrow(GuidelinesTooLargeError);
  });

  it('setGuidelines accepts content exactly at the byte cap', () => {
    const store = makeStubStore();
    const max = 'x'.repeat(GUIDELINES_MAX_BYTES);
    expect(() => setGuidelines(store, 'owner/repo', max)).not.toThrow();
  });

  it('setGuidelines counts UTF-8 byte length, not character length', () => {
    const store = makeStubStore();
    // Each emoji is 4 bytes in UTF-8. 2050 emoji = 8200 bytes, just over the cap.
    const oversized = '🚀'.repeat(2050);
    expect(() => setGuidelines(store, 'owner/repo', oversized)).toThrow(GuidelinesTooLargeError);
  });

  it('deleteGuidelines tombstones the file (empty content)', () => {
    const store = makeStubStore();
    setGuidelines(store, 'owner/repo', 'content');
    deleteGuidelines(store, 'owner/repo');
    expect(getGuidelines(store, 'owner/repo')).toBeNull();
  });

  it('getGuidelines returns null for an empty-content (tombstoned) file', () => {
    const store = makeStubStore();
    setGuidelines(store, 'owner/repo', 'real content');
    deleteGuidelines(store, 'owner/repo');
    // The underlying cached value is empty string, but getGuidelines hides it.
    expect(store.cachedFiles.get(guidelinesFilename('owner/repo'))).toBe('');
    expect(getGuidelines(store, 'owner/repo')).toBeNull();
  });

  it('deleteGuidelines throws GuidelinesNotAvailableError when store is null', () => {
    expect(() => deleteGuidelines(null, 'owner/repo')).toThrow(GuidelinesNotAvailableError);
  });

  it('round-trip: set, get, delete, get returns null', () => {
    const store = makeStubStore();
    setGuidelines(store, 'owner/repo', 'x');
    expect(getGuidelines(store, 'owner/repo')).toBe('x');
    deleteGuidelines(store, 'owner/repo');
    expect(getGuidelines(store, 'owner/repo')).toBeNull();
  });
});

describe('listGuidelinesRepos', () => {
  it('returns [] when the store is null', () => {
    expect(listGuidelinesRepos(null)).toEqual([]);
  });

  it('returns [] when no guidelines files exist', () => {
    const store = makeStubStore();
    expect(listGuidelinesRepos(store)).toEqual([]);
  });

  it('returns a sorted array of repos with stored guidelines', () => {
    const store = makeStubStore();
    setGuidelines(store, 'zebra-org/repo-a', 'a');
    setGuidelines(store, 'apple-org/repo-b', 'b');
    setGuidelines(store, 'middle-org/repo-c', 'c');
    expect(listGuidelinesRepos(store)).toEqual(['apple-org/repo-b', 'middle-org/repo-c', 'zebra-org/repo-a']);
  });

  it('excludes tombstoned (empty-content) files from the result', () => {
    const store = makeStubStore();
    setGuidelines(store, 'owner/repo-a', 'real');
    setGuidelines(store, 'owner/repo-b', 'tombstone');
    deleteGuidelines(store, 'owner/repo-b');
    expect(listGuidelinesRepos(store)).toEqual(['owner/repo-a']);
  });

  it('ignores files that do not match the guidelines naming convention', () => {
    const store = makeStubStore();
    // Manually inject a file that uses the prefix but isn't a guidelines file
    // (e.g. a hand-edited Gist entry from before the convention was finalized).
    store.cachedFiles.set('guidelines--malformed.md', 'wrong shape');
    setGuidelines(store, 'owner/real', 'good');
    expect(listGuidelinesRepos(store)).toEqual(['owner/real']);
  });
});

describe('module exports', () => {
  it('exports the file prefix and byte cap as constants', () => {
    expect(GUIDELINES_FILE_PREFIX).toBe('guidelines--');
    expect(GUIDELINES_MAX_BYTES).toBe(8192);
  });
});
