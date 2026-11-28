/**
 * CI gate: the number of inline `eslint-disable` directives that name a
 * `vitest/` rule may only go down (#2056).
 *
 * #1944 made the vitest rules that catch tests which cannot fail
 * (`no-conditional-expect`, `no-standalone-expect`, `no-disabled-tests`)
 * errors. An inline disable is the escape hatch for an audited exception, but
 * each one is also a place where a test can stop asserting anything without
 * lint noticing. This test pins the count: a new disable fails here so it gets
 * a second look, and removing one fails until the recorded number is lowered.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PACKAGES = ['core', 'dashboard', 'mcp-server'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);
const SOURCE_RE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

/** Current count on main. Lower it when you remove a disable; never raise it. */
const MAX_VITEST_DISABLES = 50;

/** A `// eslint-disable...` or `/* eslint-disable...` comment whose rule list names a `vitest/` rule. */
const DIRECTIVE_RE = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\s[^\n]*?vitest\//g;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (SOURCE_RE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Directive count per file (repo-relative path), files with none omitted. */
function countDisables(): Array<[string, number]> {
  const files = PACKAGES.flatMap((pkg) => sourceFiles(path.join(REPO_ROOT, 'packages', pkg)));
  return files
    .filter((file) => file !== __filename)
    .map((file): [string, number] => [
      path.relative(REPO_ROOT, file),
      fs.readFileSync(file, 'utf8').match(DIRECTIVE_RE)?.length ?? 0,
    ])
    .filter(([, hits]) => hits > 0);
}

describe('vitest eslint-disable ratchet (#2056)', () => {
  it('matches both disable forms and ignores other rules', () => {
    const sample = [
      '// eslint-disable-next-line vitest/no-conditional-expect -- reason',
      '/* eslint-disable vitest/no-standalone-expect */',
      '// eslint-disable-line @typescript-eslint/require-await, vitest/no-disabled-tests',
      '// eslint-disable-next-line @typescript-eslint/require-await -- reason',
      "const note = 'vitest/no-conditional-expect';",
    ].join('\n');
    expect(sample.match(DIRECTIVE_RE)).toHaveLength(3);
  });

  it(`has at most ${MAX_VITEST_DISABLES} inline disables of vitest rules`, () => {
    const counts = countDisables();
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    const listing = counts.map(([file, n]) => `  ${file}: ${n}`).join('\n');
    expect(
      total,
      `${total} eslint-disable directives name a vitest/ rule, above the recorded ${MAX_VITEST_DISABLES}. ` +
        `Make the test assert unconditionally (seed the data, use it.skipIf or it.todo) instead of disabling the rule.\n${listing}`,
    ).toBeLessThanOrEqual(MAX_VITEST_DISABLES);
    expect(
      total,
      `${total} eslint-disable directives name a vitest/ rule, below the recorded ${MAX_VITEST_DISABLES}. ` +
        `Lower MAX_VITEST_DISABLES in ${path.relative(REPO_ROOT, __filename)} to ${total}.`,
    ).toBe(MAX_VITEST_DISABLES);
  });
});
