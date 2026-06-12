/**
 * Tests for the single-source-of-truth config key registry.
 */

import { describe, it, expect } from 'vitest';
import {
  CONFIG_KEY_REGISTRY,
  getConfigKeys,
  getKeyDef,
  getSetupKeys,
  isKnownKey,
  suggestKey,
  formatUnknownKeyError,
} from './config-registry.js';

describe('CONFIG_KEY_REGISTRY', () => {
  it('has no duplicate keys', () => {
    const seen = new Set<string>();
    for (const def of CONFIG_KEY_REGISTRY) {
      expect(seen.has(def.key), `duplicate key in registry: ${def.key}`).toBe(false);
      seen.add(def.key);
    }
  });

  it('every entry has a non-empty description and value hint', () => {
    for (const def of CONFIG_KEY_REGISTRY) {
      expect(def.description.length, `${def.key} missing description`).toBeGreaterThan(0);
      expect(def.valueHint.length, `${def.key} missing value hint`).toBeGreaterThan(0);
    }
  });

  it('every key scout-bridge.ts reads is present in the registry', () => {
    // Keys that scout-bridge.ts touches but which neither command used to set.
    // The acceptance criterion for H3: every scout-bridge read must be in the registry.
    const scoutBridgeReads = [
      'maxIssueAgeDays',
      'minRepoScoreThreshold',
      'starredRepos',
      'starredReposLastFetched',
      'skippedIssuesPath',
      'avoidRepos',
      'boostIssueTypes',
    ];
    for (const key of scoutBridgeReads) {
      expect(isKnownKey(key), `scout-bridge read "${key}" not in registry`).toBe(true);
    }
  });

  it('registers the personalization bias keys on the expected surfaces (#1464)', () => {
    expect(getKeyDef('avoidRepos')?.settableVia).toBe('setup');
    expect(getKeyDef('boostIssueTypes')?.settableVia).toBe('setup');
    for (const key of ['add-avoid-repo', 'remove-avoid-repo', 'add-boost-issue-type', 'remove-boost-issue-type']) {
      expect(getKeyDef(key)?.settableVia, `${key} should be config-settable`).toBe('config');
    }
  });

  it('exposes setup and config key partitions consistently', () => {
    const setupKeys = getSetupKeys();
    const configKeys = getConfigKeys();

    // 'both' keys must appear in both lists.
    for (const def of CONFIG_KEY_REGISTRY) {
      if (def.settableVia === 'both') {
        expect(setupKeys, `${def.key} marked 'both' but missing from setup keys`).toContain(def.key);
        expect(configKeys, `${def.key} marked 'both' but missing from config keys`).toContain(def.key);
      }
      if (def.settableVia === 'auto') {
        expect(setupKeys).not.toContain(def.key);
        expect(configKeys).not.toContain(def.key);
      }
    }
  });
});

describe('isKnownKey / getKeyDef', () => {
  it('returns true for a registered key', () => {
    expect(isKnownKey('username')).toBe(true);
    expect(isKnownKey('add-label')).toBe(true);
  });

  it('returns false for unregistered keys', () => {
    expect(isKnownKey('bogus')).toBe(false);
    expect(isKnownKey('')).toBe(false);
  });

  it('getKeyDef returns the definition object', () => {
    const def = getKeyDef('username');
    expect(def).toBeDefined();
    expect(def?.settableVia).toBe('both');
  });
});

describe('suggestKey', () => {
  it('suggests a close match (one-char typo)', () => {
    expect(suggestKey('usrname', 'setup')).toBe('username');
    expect(suggestKey('add-lable', 'config')).toBe('add-label');
  });

  it('does not suggest when no candidate is close enough', () => {
    expect(suggestKey('xyzabc', 'setup')).toBeUndefined();
  });

  it('respects the surface: config-only keys are not suggested for setup typos', () => {
    // 'add-label' lives on the config surface only. A setup typo that would
    // otherwise match it should not be suggested.
    expect(suggestKey('add-label', 'setup')).not.toBe('add-label');
  });

  it('suggests case-insensitively', () => {
    expect(suggestKey('USERNAME', 'setup')).toBe('username');
  });
});

describe('formatUnknownKeyError', () => {
  it('includes a did-you-mean suggestion when confident', () => {
    const msg = formatUnknownKeyError('usrname', 'setup');
    expect(msg).toMatch(/did you mean "username"/i);
    expect(msg).toMatch(/config --list-keys/);
  });

  it('points at --list-keys even when no suggestion is confident', () => {
    const msg = formatUnknownKeyError('xyzabc', 'setup');
    expect(msg).not.toMatch(/did you mean/i);
    expect(msg).toMatch(/config --list-keys/);
  });

  it('labels setup vs config surfaces distinctly', () => {
    expect(formatUnknownKeyError('xyzabc', 'setup')).toMatch(/Unknown setting "xyzabc"/);
    expect(formatUnknownKeyError('xyzabc', 'config')).toMatch(/Unknown config key "xyzabc"/);
  });
});
