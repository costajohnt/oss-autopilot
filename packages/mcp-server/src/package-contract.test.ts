/**
 * The published package must install nothing but itself (#2007). `.mcp.json`
 * launches it with `npx @oss-autopilot/mcp@<version>`, and npx resolves every
 * runtime dependency fresh by semver range, running install scripts, although
 * the esbuild bundle inlines all of them. Build-time packages belong in
 * devDependencies, and every runtime entry point must be the bundle.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readText = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const manifest = readText('../package.json');
const pkg = JSON.parse(manifest);
const BUNDLE = './dist/mcp-server.bundle.cjs';

describe('@oss-autopilot/mcp package.json', () => {
  it.each(['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'])(
    'declares no %s',
    (field) => {
      expect(pkg[field]).toBeUndefined();
    },
  );

  it('points the bin at the bundle', () => {
    expect(Object.values(pkg.bin)).toEqual([BUNDLE]);
  });

  it('points the library entry at the bundle, not the unbundled tsc output', () => {
    expect(pkg.main).toBeUndefined();
    expect(pkg.module).toBeUndefined();
    expect(Object.keys(pkg.exports)).toEqual(['.']);
    const { types, ...runtime } = pkg.exports['.'];
    expect(types).toBe('./dist/index.d.ts');
    expect(runtime).toEqual({ default: BUNDLE });
  });
});

/**
 * The packages below ship inside the bundle but are devDependencies, so
 * Dependabot titles their bumps `chore`, which release-please ignores: a
 * security fix in the MCP SDK would never reach npm. Recording their locked
 * versions here makes such a bump fail CI until someone updates the marker and
 * merges it under a releasable title, which queues an MCP release.
 */
describe('BUNDLED_RUNTIME_VERSIONS', () => {
  const marker: Record<string, string> = JSON.parse(readText('../BUNDLED_RUNTIME_VERSIONS'));
  const lockfile = readText('../../../pnpm-lock.yaml');

  it.each(Object.entries(marker))('records the locked version of %s', (name, recorded) => {
    expect(pkg.devDependencies).toHaveProperty([name]);
    expect(
      lockedVersion(lockfile, name),
      `${name} changed in pnpm-lock.yaml. It is bundled into the MCP server, so set its version in ` +
        'packages/mcp-server/BUNDLED_RUNTIME_VERSIONS and merge with a `fix(mcp):` PR title ' +
        '(squash merges keep the title) so release-please publishes a new MCP server.',
    ).toBe(recorded);
  });
});

/** The version pnpm-lock.yaml resolves `name` to for packages/mcp-server, without peer suffixes. */
function lockedVersion(lockfile: string, name: string): string | undefined {
  const importer = /^ {2}packages\/mcp-server:\n((?: {4}.*\n)+)/m.exec(lockfile)?.[1] ?? '';
  const quoted = name.startsWith('@') ? `'${name}'` : name;
  const escaped = quoted.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
  const entry = new RegExp(String.raw`^ {6}${escaped}:\n {8}specifier: .*\n {8}version: ([^(\s]+)`, 'm');
  return entry.exec(importer)?.[1];
}
