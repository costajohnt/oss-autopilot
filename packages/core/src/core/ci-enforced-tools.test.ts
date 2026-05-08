/**
 * Tests for `getCIEnforcedTools` (#1286).
 */

import { describe, it, expect } from 'vitest';
import { getCIEnforcedTools } from './ci-enforced-tools.js';

describe('getCIEnforcedTools — pre-commit', () => {
  it('detects eslint and prettier from a pre-commit config', () => {
    const yaml = `
repos:
  - repo: local
    hooks:
      - id: eslint
        name: ESLint
        entry: npx eslint
      - id: prettier
        name: Prettier
        entry: npx prettier --write
`;
    const out = getCIEnforcedTools({
      preCommitConfigYaml: yaml,
      workflowYamls: null,
      makefile: null,
      packageJson: null,
    });
    expect(out.map((e) => e.tool)).toEqual(expect.arrayContaining(['lint', 'format']));
    expect(out.every((e) => e.source === 'pre-commit')).toBe(true);
  });
});

describe('getCIEnforcedTools — github workflows', () => {
  it('detects vitest as test, tsc as typecheck', () => {
    const yaml = `
jobs:
  test:
    steps:
      - run: pnpm exec vitest run
      - run: tsc --noEmit
`;
    const out = getCIEnforcedTools({
      preCommitConfigYaml: null,
      workflowYamls: yaml,
      makefile: null,
      packageJson: null,
    });
    expect(out.find((e) => e.tool === 'test')?.source).toBe('github-workflow');
    expect(out.find((e) => e.tool === 'typecheck')?.source).toBe('github-workflow');
  });

  it('detects security scanners', () => {
    const yaml = 'jobs:\n  scan:\n    steps:\n      - uses: github/codeql-action\n';
    const out = getCIEnforcedTools({
      preCommitConfigYaml: null,
      workflowYamls: yaml,
      makefile: null,
      packageJson: null,
    });
    expect(out.find((e) => e.tool === 'security-scan')?.evidence).toContain('codeql');
  });
});

describe('getCIEnforcedTools — package.json', () => {
  it('extracts script-named tools without re-running grep', () => {
    const pkg = JSON.stringify({
      scripts: {
        lint: 'eslint .',
        'format:check': 'prettier --check .',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        build: 'tsup',
      },
    });
    const out = getCIEnforcedTools({
      preCommitConfigYaml: null,
      workflowYamls: null,
      makefile: null,
      packageJson: pkg,
    });
    const tools = out.filter((e) => e.source === 'package-json').map((e) => e.tool);
    expect(tools).toEqual(expect.arrayContaining(['lint', 'format', 'typecheck', 'test', 'build']));
  });

  it('returns nothing on malformed package.json (does not throw)', () => {
    const out = getCIEnforcedTools({
      preCommitConfigYaml: null,
      workflowYamls: null,
      makefile: null,
      packageJson: '{invalid',
    });
    expect(out).toEqual([]);
  });
});

describe('getCIEnforcedTools — empty input', () => {
  it('returns empty array when every source is null', () => {
    const out = getCIEnforcedTools({
      preCommitConfigYaml: null,
      workflowYamls: null,
      makefile: null,
      packageJson: null,
    });
    expect(out).toEqual([]);
  });
});
