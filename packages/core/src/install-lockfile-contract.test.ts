/**
 * CI gate: nothing the plugin runs or tells a user to run installs
 * dependencies without the lockfile (#1935).
 *
 * Marketplace installs get the prebuilt `directory` branch, so nothing is
 * installed on a user's machine. The build helpers only build in a source
 * checkout, and only from pnpm-lock.yaml. This test keeps an unlocked
 * install (`npm install`, a lockfile-rewriting `update`/`add`, `pnpm dlx`,
 * an unpinned `npx`, another package manager) from creeping back into the
 * helpers or into the prompt markdown that agents execute.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/** `pnpm@x.y.z` from the root package.json `packageManager` field. */
const PINNED_PNPM = (JSON.parse(readRepoFile('package.json')) as { packageManager: string }).packageManager;
/**
 * The one install that cannot come from the lockfile: pnpm itself, for a
 * contributor who has none. Exempt only at the exact version the repo pins.
 */
const PNPM_BOOTSTRAP = `npm install -g ${PINNED_PNPM}`;

/** Anything that fetches packages: installs, lockfile rewrites, one-shot runners. */
const FETCH_VERBS = 'install|i|ci|add|update|up|upgrade|dlx|x|create';
const FETCH_RE = new RegExp(String.raw`\b(?:(?:npm|pnpm|yarn|bun)\s+(?:${FETCH_VERBS})|npx|pnpx|bunx)(?=\s|$)`, 'g');
const EXACT_VERSION_SPEC = /^(?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+$/;

/** True when one shell command fetches only what a lockfile or exact version pins. */
function isLocked(command: string): boolean {
  if (command === PNPM_BOOTSTRAP) return true;
  const tokens = command.split(/\s+/);
  if (tokens[0] === 'npx') {
    // `--no-install` runs a binary the project already has and never downloads.
    if (tokens.includes('--no-install')) return true;
    const spec = tokens.slice(1).find((token) => !token.startsWith('-'));
    return spec !== undefined && EXACT_VERSION_SPEC.test(spec);
  }
  if (tokens[0] === 'pnpm' && (tokens[1] === 'install' || tokens[1] === 'i')) {
    return (
      tokens.includes('--frozen-lockfile') &&
      tokens.every((token) => token !== '--no-frozen-lockfile' && !token.startsWith('--frozen-lockfile='))
    );
  }
  return false;
}

/** Fetching commands in a text, each cut at the end of its own shell command. */
function fetchCommands(text: string): Array<{ line: number; command: string }> {
  const found: Array<{ line: number; command: string }> = [];
  for (const [index, line] of text.split('\n').entries()) {
    for (const match of line.matchAll(FETCH_RE)) {
      // Up to the next `&&`, `||`, `;`, `)`, quote, backtick or shell comment.
      const command = line
        .slice(match.index)
        .split(/&&|\|\||[;)"`]|\s#/, 1)[0]
        .trim();
      found.push({ line: index + 1, command });
    }
  }
  return found;
}

function markdownUnder(dir: string): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.md'))
    .map((rel) => path.join(dir, rel));
}

const HELPERS = ['scripts/build-cli-if-stale.sh', 'scripts/build-dashboard-if-stale.sh'];
const PLUGIN_MARKDOWN = ['commands', 'workflows', 'agents', 'skills'].flatMap((dir) => markdownUnder(dir));

describe('the lockfile check itself', () => {
  it.each([
    'pnpm install --frozen-lockfile',
    'pnpm install --silent --frozen-lockfile --ignore-scripts',
    'pnpm i --frozen-lockfile',
    'npx @oss-autopilot/mcp@5.11.3',
    'npx -y some-tool@1.2.3 --flag',
    'npx --no-install prettier --write file.ts',
    PNPM_BOOTSTRAP,
  ])('accepts %s', (command) => {
    expect(fetchCommands(command).map((found) => isLocked(found.command))).toEqual([true]);
  });

  it.each([
    'npm install',
    'npm install --frozen-lockfile',
    'npm ci',
    'pnpm install',
    'pnpm install --frozen-lockfile=false',
    'pnpm install --no-frozen-lockfile',
    'pnpm install --frozen-lockfile --no-frozen-lockfile',
    'pnpm install # always pass --frozen-lockfile',
    'pnpm install && echo --frozen-lockfile',
    'pnpm --filter @oss-autopilot/core update @oss-scout/core',
    'pnpm add zod',
    'pnpm dlx some-tool',
    'pnpx some-tool',
    'npx some-tool',
    'npx some-tool@latest',
    'npx -y some-tool@^1.2.3',
    'yarn install',
    'yarn add zod',
    'bun install',
    'bunx some-tool',
    'npm install -g pnpm',
    'npm install -g pnpm@latest',
    `${PNPM_BOOTSTRAP} left-pad`,
  ])('rejects %s', (command) => {
    const verdicts = fetchCommands(command.replace('--filter @oss-autopilot/core ', '')).map((found) =>
      isLocked(found.command),
    );
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts).toContain(false);
  });
});

describe('dependency installs are lockfile-only (#1935)', () => {
  it('finds no unlocked fetch in the helpers or the plugin markdown', () => {
    const scanned = [...HELPERS, ...PLUGIN_MARKDOWN];
    expect(scanned.length).toBeGreaterThan(20);
    const unlocked = scanned.flatMap((relPath) =>
      fetchCommands(readRepoFile(relPath))
        .filter((found) => !isLocked(found.command))
        .map((found) => `${relPath}:${found.line}: ${found.command}`),
    );
    expect(unlocked).toEqual([]);
  });

  it('the helpers do fetch, so the scan above is looking at real commands', () => {
    for (const helper of HELPERS) {
      const commands = fetchCommands(readRepoFile(helper)).map((found) => found.command);
      expect(commands).toContain('pnpm install --silent --frozen-lockfile --ignore-scripts');
    }
  });

  it('the CLI helper never runs npm', () => {
    const code = readRepoFile('scripts/build-cli-if-stale.sh')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#') && !line.includes('echo "BUILD_FAILED'))
      .join('\n');
    expect(code).not.toMatch(/\bnpm\s/);
  });

  it('the MCP server is launched at an exact pinned version', () => {
    const mcp = JSON.parse(readRepoFile('.mcp.json')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    for (const server of Object.values(mcp.mcpServers)) {
      expect(isLocked([server.command, ...server.args].join(' '))).toBe(true);
    }
  });
});

describe('marketplace installs get the prebuilt tree (#1935)', () => {
  it('the marketplace serves the directory branch over HTTPS, not the source tree', () => {
    // The `url` form installs and updates over HTTPS. The `github` form
    // updates over SSH only, which fails for users without GitHub SSH keys.
    const marketplace = JSON.parse(readRepoFile('.claude-plugin/marketplace.json')) as {
      plugins: Array<{ source: unknown }>;
    };
    expect(marketplace.plugins.map((plugin) => plugin.source)).toEqual([
      { source: 'url', url: 'https://github.com/costajohnt/oss-autopilot.git', ref: 'directory' },
    ]);
  });

  it('plugin markdown does not point agents at source files the prebuilt tree lacks', () => {
    const pointers = PLUGIN_MARKDOWN.filter((relPath) =>
      /packages\/(?:core|dashboard|mcp-server)\/src\b/.test(readRepoFile(relPath)),
    );
    expect(pointers).toEqual([]);
  });
});
