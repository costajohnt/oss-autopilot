/**
 * Drift-detection test: every command registered in `cli-registry.ts` must be
 * documented in `workflows/reference.md`.
 *
 * Prevents the recurrence of #1048, where actively-used commands like
 * `skip-add`, `pr-template`, `state`, and `vet-list` silently disappeared from
 * the supposedly-authoritative reference file.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { commands } from './cli-registry.js';

describe('cli-registry ↔ workflows/reference.md parity (#1048)', () => {
  const referencePath = path.resolve(__dirname, '../../../workflows/reference.md');

  it('workflows/reference.md exists', () => {
    expect(fs.existsSync(referencePath)).toBe(true);
  });

  it('every registered CLI command appears in workflows/reference.md', () => {
    const doc = fs.readFileSync(referencePath, 'utf8');
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

describe('cli-registry ↔ .claude-plugin/expected-cli-contract.json parity (#1190)', () => {
  const contractPath = path.resolve(__dirname, '../../../.claude-plugin/expected-cli-contract.json');
  const pluginRoot = path.resolve(__dirname, '../../..');

  interface Contract {
    schemaVersion: number;
    expectedCommands: string[];
    expectedWorkflowFiles: string[];
  }

  it('expected-cli-contract.json exists', () => {
    expect(fs.existsSync(contractPath)).toBe(true);
  });

  it('every command in expectedCommands is registered (no plugin-side dangling references)', () => {
    const contract: Contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const registered = new Set(commands.map((c) => c.name));
    const dangling = contract.expectedCommands.filter((name) => !registered.has(name));
    expect(
      dangling,
      `Commands referenced by the plugin contract but missing from cli-registry.ts: ${dangling.join(', ')}. ` +
        `Either restore the command or remove it from .claude-plugin/expected-cli-contract.json.`,
    ).toEqual([]);
  });

  it('every registered command appears in expectedCommands (no silent additions)', () => {
    const contract: Contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const expected = new Set(contract.expectedCommands);
    const unlisted = commands.map((c) => c.name).filter((name) => !expected.has(name));
    expect(
      unlisted,
      `New CLI commands not yet pinned in the plugin contract: ${unlisted.join(', ')}. ` +
        `Add them to .claude-plugin/expected-cli-contract.json so plugin/markdown drift is caught at session start.`,
    ).toEqual([]);
  });

  it('every workflow file referenced by the contract exists on disk', () => {
    const contract: Contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const missing = contract.expectedWorkflowFiles.filter((rel) => !fs.existsSync(path.join(pluginRoot, rel)));
    expect(missing, `Workflow files referenced by the contract are missing: ${missing.join(', ')}`).toEqual([]);
  });
});
