/**
 * CI gate: every stored copy of a version agrees with its source of truth (#1947).
 *
 * Core and the MCP server are versioned separately by release-please. Each
 * version is copied into files that something other than release-please's
 * main updater maintains (an extra-files entry, scripts/sync-mcp-pin.mjs, a
 * release-please.yml step), and each copy has drifted at least once:
 * packages/mcp-server/BUNDLED_CORE_VERSION sat one core release behind
 * whenever a release bumped core and the MCP server together.
 *
 * A release PR is red here until release-please.yml has pushed its follow-up
 * commits (the .mcp.json pin and the marker); the head it leaves is green.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function readJson(relativePath: string): any {
  return JSON.parse(readText(relativePath));
}

const coreVersion: string = readJson('packages/core/package.json').version;
const mcpVersion: string = readJson('packages/mcp-server/package.json').version;

describe('version sources (#1947)', () => {
  it('every copy of the core version matches packages/core/package.json', () => {
    expect({
      '.release-please-manifest.json': readJson('.release-please-manifest.json')['.'],
      '.claude-plugin/plugin.json': readJson('.claude-plugin/plugin.json').version,
      'packages/mcp-server/BUNDLED_CORE_VERSION': readText('packages/mcp-server/BUNDLED_CORE_VERSION').trim(),
    }).toEqual({
      '.release-please-manifest.json': coreVersion,
      '.claude-plugin/plugin.json': coreVersion,
      'packages/mcp-server/BUNDLED_CORE_VERSION': coreVersion,
    });
  });

  it('every copy of the MCP server version matches packages/mcp-server/package.json', () => {
    const server = readJson('packages/mcp-server/server.json');
    expect({
      '.release-please-manifest.json': readJson('.release-please-manifest.json')['packages/mcp-server'],
      'server.json version': server.version,
      'server.json packages[0].version': server.packages[0].version,
      '.mcp.json pin': (readJson('.mcp.json').mcpServers['oss-autopilot'].args as string[]).find((arg) =>
        arg.startsWith('@oss-autopilot/mcp@'),
      ),
    }).toEqual({
      '.release-please-manifest.json': mcpVersion,
      'server.json version': mcpVersion,
      'server.json packages[0].version': mcpVersion,
      '.mcp.json pin': `@oss-autopilot/mcp@${mcpVersion}`,
    });
  });
});

// The MCP server bundle inlines core, so the core version it reports must come
// from the build, not from a constant someone bumps. Bundle getCLIVersion() the
// way every package does and run it where no package.json sits beside it.
describe('bundled core version (#1947)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-autopilot-bundled-version-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('scripts/bundle.mjs injects the version from packages/core/package.json', () => {
    const entry = path.join(tmp, 'entry.ts');
    const outfile = path.join(tmp, 'out', 'entry.cjs');
    const paths = path.join(REPO_ROOT, 'packages/core/src/core/paths.ts');
    fs.writeFileSync(
      entry,
      `import { getCLIVersion } from ${JSON.stringify(paths)};\nprocess.stdout.write(getCLIVersion());\n`,
    );
    // esbuild resolves from the package directory, as in each `bundle` script.
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/bundle.mjs'), entry, outfile], {
      cwd: path.join(REPO_ROOT, 'packages/core'),
    });
    expect(execFileSync(process.execPath, [outfile], { encoding: 'utf8' })).toBe(coreVersion);
  });
});
