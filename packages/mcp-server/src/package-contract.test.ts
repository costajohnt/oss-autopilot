/**
 * The published package must install nothing but itself (#2007). `.mcp.json`
 * launches it with `npx @oss-autopilot/mcp@<version>`, and npx resolves every
 * runtime dependency fresh by semver range, running install scripts, although
 * the esbuild bundle inlines all of them. Build-time packages belong in
 * devDependencies, and every runtime entry point must be the bundle.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
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
    const { types, ...runtime } = pkg.exports['.'];
    expect(types).toBe('./dist/index.d.ts');
    expect(runtime).toEqual({ default: BUNDLE });
  });
});
