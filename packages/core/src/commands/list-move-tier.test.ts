/**
 * Tests for list-move-tier (#1107).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { moveIssueToTier, runListMoveTier } from './list-move-tier.js';

const URL_A = 'https://github.com/foo/bar/issues/1';
const URL_B = 'https://github.com/foo/bar/issues/2';
const URL_C = 'https://github.com/baz/qux/issues/42';

describe('moveIssueToTier (pure transform)', () => {
  it('moves an entry from Pursue to Skip and preserves sub-bullets', () => {
    const content = [
      '# My List',
      '',
      '## Pursue',
      '',
      `- [Issue A](${URL_A})`,
      '  - **Score 8/10**',
      '  - Quick start: do X',
      `- [Issue B](${URL_B})`,
      '',
      '## Skip',
      '',
      `- [Existing](${URL_C})`,
      '',
    ].join('\n');

    const result = moveIssueToTier(content, URL_A, 'skip');

    expect(result.moved).toBe(true);
    expect(result.fromTier).toBe('Pursue');
    expect(result.count).toBe(1);

    // The sub-bullets should travel with the issue line
    expect(result.content).toContain(`- [Issue A](${URL_A})\n  - **Score 8/10**\n  - Quick start: do X`);

    // It should land under "## Skip" before the existing entry
    const skipIdx = result.content.indexOf('## Skip');
    const newEntryIdx = result.content.indexOf(`[Issue A](${URL_A})`);
    const existingIdx = result.content.indexOf(`[Existing](${URL_C})`);
    expect(skipIdx).toBeLessThan(newEntryIdx);
    expect(newEntryIdx).toBeLessThan(existingIdx);

    // Pursue should no longer contain Issue A
    const pursueSection = result.content.slice(result.content.indexOf('## Pursue'), result.content.indexOf('## Skip'));
    expect(pursueSection).not.toContain(URL_A);
    expect(pursueSection).toContain(URL_B);
  });

  it('returns moved=false when the issue URL is not found', () => {
    const content = '## Pursue\n\n- nothing here\n';
    const result = moveIssueToTier(content, URL_A, 'maybe');
    expect(result.moved).toBe(false);
    expect(result.count).toBe(0);
    expect(result.reason).toMatch(/not found/);
    expect(result.content).toBe(content);
  });

  it('is idempotent — already in target tier is a no-op', () => {
    const content = ['## Pursue', '', `- [A](${URL_A})`, ''].join('\n');
    const result = moveIssueToTier(content, URL_A, 'pursue');
    expect(result.moved).toBe(false);
    expect(result.fromTier).toBe('Pursue');
    expect(result.reason).toMatch(/already/);
    expect(result.content).toBe(content);
  });

  it('moves multiple matches when the same URL appears more than once', () => {
    const content = [
      '## Pursue',
      '',
      `- [A first](${URL_A})`,
      '',
      '## Maybe',
      '',
      `- [A duplicate](${URL_A})`,
      '',
    ].join('\n');

    const result = moveIssueToTier(content, URL_A, 'skip');

    expect(result.moved).toBe(true);
    expect(result.count).toBe(2);
    // Both Pursue and Maybe should be empty of A
    const pursueSection = result.content.slice(result.content.indexOf('## Pursue'), result.content.indexOf('## Maybe'));
    const maybeSection = result.content.slice(result.content.indexOf('## Maybe'), result.content.indexOf('## Skip'));
    expect(pursueSection).not.toContain(URL_A);
    expect(maybeSection).not.toContain(URL_A);
    // Both copies should now be in Skip
    const skipSection = result.content.slice(result.content.indexOf('## Skip'));
    expect(skipSection.match(new RegExp(URL_A.replace(/[/.]/g, '\\$&'), 'g'))?.length).toBe(2);
  });

  it('creates the target tier section when missing', () => {
    const content = ['# Index', '', '## Pursue', '', `- [A](${URL_A})`, ''].join('\n');
    const result = moveIssueToTier(content, URL_A, 'skip');
    expect(result.moved).toBe(true);
    expect(result.content).toContain('## Skip');
    expect(result.content).toContain(`[A](${URL_A})`);
  });

  it('preserves blank lines and prose between entries', () => {
    const content = [
      '## Pursue',
      '',
      '<!-- pursue notes -->',
      '',
      `- [A](${URL_A})`,
      '',
      `- [B](${URL_B})`,
      '',
      '## Skip',
      '',
    ].join('\n');

    const result = moveIssueToTier(content, URL_A, 'skip');
    expect(result.moved).toBe(true);
    // Pursue should still have its leading comment and Issue B
    expect(result.content).toContain('<!-- pursue notes -->');
    expect(result.content).toContain(`[B](${URL_B})`);
    // Issue A should be in Skip
    const skipSection = result.content.slice(result.content.indexOf('## Skip'));
    expect(skipSection).toContain(URL_A);
  });
});

describe('runListMoveTier (filesystem)', () => {
  let tmpDir: string;
  let listPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-move-tier-test-'));
    listPath = path.join(tmpDir, 'list.md');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads, moves, writes, and returns the resolved file path', async () => {
    fs.writeFileSync(listPath, ['## Pursue', '', `- [A](${URL_A})`, ''].join('\n'));
    const out = await runListMoveTier({ issueUrl: URL_A, tier: 'skip', listPath });
    expect(out.moved).toBe(true);
    expect(out.toTier).toBe('skip');
    expect(out.fromTier).toBe('Pursue');
    expect(out.filePath).toBe(path.resolve(listPath));
    expect(out.url).toBe(URL_A);
    expect(out.count).toBe(1);

    const after = fs.readFileSync(listPath, 'utf-8');
    expect(after).toContain('## Skip');
    expect(after.indexOf('## Skip')).toBeLessThan(after.indexOf(URL_A));
  });

  it('throws when the file does not exist', async () => {
    await expect(runListMoveTier({ issueUrl: URL_A, tier: 'skip', listPath })).rejects.toThrow(/File not found/);
  });

  it('does not touch the file when the URL is not present', async () => {
    const original = '## Pursue\n\n- [Other](https://github.com/x/y/issues/9)\n';
    fs.writeFileSync(listPath, original);
    const before = fs.statSync(listPath).mtimeMs;
    // small delay to allow mtime resolution
    await new Promise((r) => setTimeout(r, 10));
    const out = await runListMoveTier({ issueUrl: URL_A, tier: 'pursue', listPath });
    expect(out.moved).toBe(false);
    expect(out.count).toBe(0);
    const after = fs.statSync(listPath).mtimeMs;
    expect(after).toBe(before); // no write happened
    expect(fs.readFileSync(listPath, 'utf-8')).toBe(original);
  });
});
