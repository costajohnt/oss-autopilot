/**
 * Drift-detection test: every command registered in `cli-registry.ts` must be
 * documented in `workflows/reference.md`.
 *
 * Prevents the recurrence of #1048, where actively-used commands like
 * `skip-add`, `pr-template`, `state`, and `vet-list` silently disappeared from
 * the supposedly-authoritative reference file.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { commands } from './cli-registry.js';

describe('cli-registry ↔ workflows/reference.md parity (#1048)', () => {
  const referencePath = path.resolve(__dirname, '../../../workflows/reference.md');

  it('workflows/reference.md exists', () => {
    expect(fs.existsSync(referencePath)).toBe(true);
  });

  it('every registered CLI command appears in workflows/reference.md', () => {
    const doc = fs.readFileSync(referencePath, 'utf-8');
    const missing: string[] = [];
    for (const cmd of commands) {
      // Use word-boundaries so `state` does not match `statement` or `state-sync`,
      // and `setup` does not match `setupComplete`. Hyphens break \b, so build a
      // pattern that tolerates both hyphen and non-hyphen boundaries.
      const pattern = new RegExp(
        `(^|[^A-Za-z0-9-])${cmd.name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([^A-Za-z0-9-]|$)`,
      );
      if (!pattern.test(doc)) {
        missing.push(cmd.name);
      }
    }
    expect(missing, `Add these commands to workflows/reference.md: ${missing.join(', ')}`).toEqual([]);
  });
});
