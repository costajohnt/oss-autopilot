/**
 * CI gate: the CLI e2e suites must actually run in CI (#1366).
 *
 * Every *.e2e.test.ts suite executes dist/cli.bundle.cjs and gates on
 * `describe.skipIf(!BUNDLE_EXISTS)` so plain local `vitest` runs don't
 * require a build step. That skip is silent by design — and in CI it
 * silently disabled all six suites for months because ci.yml ran tests
 * before building the bundle.
 *
 * This test converts that silent skip into a loud failure: when CI is
 * set, the bundle must exist by the time the test suite runs. If this
 * fails, fix the workflow ordering (the "Build CLI bundle" step must
 * precede "Run tests" in .github/workflows/ci.yml); do not delete or
 * skip this test.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BUNDLE_PATH = path.resolve(__dirname, '../../dist/cli.bundle.cjs');

describe('CLI e2e bundle gate (#1366)', () => {
  it.runIf(process.env.CI)('dist/cli.bundle.cjs exists in CI so e2e suites cannot silently skip', () => {
    expect(fs.existsSync(BUNDLE_PATH), `expected CLI bundle at ${BUNDLE_PATH}`).toBe(true);
  });
});
