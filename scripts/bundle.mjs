#!/usr/bin/env node
/**
 * Build a package's single-file CJS bundle with esbuild. Run from the package
 * directory (each package's `bundle` script does this):
 *
 *   node ../../scripts/bundle.mjs <entry> <outfile> [--sourcemap]
 *
 * Same flags as the old per-package esbuild one-liners, plus one plugin: zod's
 * classic entry re-exports every locale (`export * as locales`) from both
 * `v4/classic/external.js` and `v4/core/index.js`, and esbuild cannot
 * tree-shake `export * as` namespaces, so all ~40 locales (~255 KB minified)
 * landed in every bundle although nothing here reads `z.locales` (#1651).
 * The plugin swaps zod's `locales/index.js` for a module that only re-exports
 * `en` (which zod registers as the default locale anyway). Consequence: inside
 * a bundle, `z.locales.<anything but en>` is `undefined` at runtime rather
 * than a build-time error; no current caller uses it.
 *
 * Set BUNDLE_METAFILE=<path> to also write an esbuild metafile for size work.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// esbuild is a devDependency of each package, not of the workspace root.
const { build } = createRequire(path.join(process.cwd(), 'package.json'))('esbuild');

const [entry, outfile, ...flags] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: node scripts/bundle.mjs <entry> <outfile> [--sourcemap]');
  process.exit(2);
}

const onlyEnLocale = {
  name: 'zod-only-en-locale',
  setup(b) {
    b.onResolve({ filter: /\/locales\/index\.js$/ }, (args) => {
      if (!args.importer.includes(`${path.sep}node_modules${path.sep}zod${path.sep}`)) return null;
      return { path: path.resolve(args.resolveDir, args.path), namespace: 'zod-only-en-locale' };
    });
    b.onLoad({ filter: /.*/, namespace: 'zod-only-en-locale' }, (args) => ({
      contents: 'export { default as en } from "./en.js";',
      resolveDir: path.dirname(args.path),
    }));
  },
};

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: flags.includes('--sourcemap'),
  outfile,
  metafile: Boolean(process.env.BUNDLE_METAFILE),
  plugins: [onlyEnLocale],
});
if (process.env.BUNDLE_METAFILE) writeFileSync(process.env.BUNDLE_METAFILE, JSON.stringify(result.metafile));
