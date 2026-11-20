/**
 * CI gate: nothing the plugin runs or tells a user to run installs
 * dependencies without the lockfile (#1935).
 *
 * Marketplace installs get the prebuilt `directory` branch, so nothing is
 * installed on a user's machine. The build helpers only build in a source
 * checkout, and only from pnpm-lock.yaml. This test keeps an unlocked
 * `npm install` (or a lockfile-rewriting `update`/`add`) from creeping back
 * into the helpers or into the prompt markdown that agents execute.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const INSTALL_RE = /\b(?:npm|pnpm)\s+(?:install|i|ci|add|update|up)\b/g;
/** Installing the package manager itself is the one hint that cannot be locked. */
const PNPM_BOOTSTRAP = 'npm install -g pnpm';

function markdownUnder(dir: string): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.md'))
    .map((rel) => path.join(dir, rel));
}

function unlockedInstalls(relPath: string): string[] {
  const found: string[] = [];
  const lines = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(INSTALL_RE)) {
      // One shell command: up to the next `&&`, `;`, `)` or closing backtick.
      const command = line
        .slice(match.index)
        .split(/&&|[;)`]/, 1)[0]
        .trim();
      if (command.includes('--frozen-lockfile') || command.startsWith(PNPM_BOOTSTRAP)) continue;
      found.push(`${relPath}:${index + 1}: ${command}`);
    }
  }
  return found;
}

describe('dependency installs are lockfile-only (#1935)', () => {
  const scanned = [
    'scripts/build-cli-if-stale.sh',
    'scripts/build-dashboard-if-stale.sh',
    ...['commands', 'workflows', 'agents', 'skills'].flatMap((dir) => markdownUnder(dir)),
  ];

  it('scans the helpers and the plugin markdown', () => {
    expect(scanned.length).toBeGreaterThan(20);
    expect(unlockedInstalls('scripts/build-cli-if-stale.sh')).toEqual([]);
  });

  it('finds no install command without --frozen-lockfile', () => {
    expect(scanned.flatMap((relPath) => unlockedInstalls(relPath))).toEqual([]);
  });

  it('the CLI helper installs with lifecycle scripts off and never calls npm to install', () => {
    const helper = fs.readFileSync(path.join(REPO_ROOT, 'scripts/build-cli-if-stale.sh'), 'utf8');
    const code = helper
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#') && !line.includes('echo "BUILD_FAILED'))
      .join('\n');
    expect(code).toContain('pnpm install --silent --frozen-lockfile --ignore-scripts');
    expect(code).not.toMatch(/\bnpm\s/);
  });

  it('the marketplace serves the prebuilt directory branch, not the source tree', () => {
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, '.claude-plugin/marketplace.json'), 'utf8'),
    ) as { plugins: Array<{ source: unknown }> };
    expect(marketplace.plugins.map((plugin) => plugin.source)).toEqual([
      { source: 'github', repo: 'costajohnt/oss-autopilot', ref: 'directory' },
    ]);
  });
});
