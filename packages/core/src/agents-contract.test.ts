/**
 * CI gate: every MCP tool name and CLI command name referenced in
 * `agents/*.md` must exist in the registry (#1245).
 *
 * The pr-compliance-checker agent shipped two consecutive bugs where its
 * frontmatter referenced `mcp__plugin_oss-autopilot_oss-autopilot__read`
 * (a tool that has never existed) and its prompt body invoked
 * `cli.bundle.cjs read <pr-url>` (a command that has never existed).
 * Both went undiscovered for months because nothing validated agent
 * markdown against the actual registry. This test does that validation
 * at CI time.
 *
 * Scope:
 *   - Frontmatter `tools:` array entries matching
 *     `mcp__plugin_oss-autopilot_oss-autopilot__<name>` are stripped to
 *     `<name>` and asserted against the live MCP tool list.
 *   - Bash blocks invoking `cli.bundle.cjs <command>` are scanned and
 *     `<command>` is asserted against the live CLI registry.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { commands } from './cli-registry.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');

const MCP_TOOL_PATTERN = /mcp__plugin_oss-autopilot_oss-autopilot__([a-z][a-z0-9-]*)/g;
const CLI_BUNDLE_PATTERN = /cli\.bundle\.cjs"?\s+([a-z][a-z0-9-]*)/g;

/**
 * Mirror of `EXPECTED_TOOLS` in
 * `packages/mcp-server/src/tools.test.ts`. Duplicated here (rather than
 * imported) so this test stays inside `@oss-autopilot/core` and does
 * not introduce a cross-package import that breaks the workspace's
 * module-resolution graph.
 */
const REGISTERED_MCP_TOOLS = new Set([
  'daily',
  'status',
  'search',
  'features',
  'vet',
  'vet-list',
  'track',
  'compliance-score',
  'repo-vet',
  'strategy',
  'comments',
  'post',
  'claim',
  'config',
  'init',
  'setup',
  'check-setup',
  'startup',
  'shelve',
  'unshelve',
  'dismiss',
  'undismiss',
  'move',
  'state-show',
  'state-sync',
  'state-unlink',
  'guidelines-get',
  'guidelines-store',
  'guidelines-reset',
  'guidelines-fetch-corpus',
]);

const MCP_TOOLS_SOURCE = path.join(REPO_ROOT, 'packages/mcp-server/src/tools.ts');
const REGISTER_TOOL_PATTERN = /registerTool\(\s*'([a-z][a-z0-9-]*)'/g;

interface AgentReference {
  agent: string;
  reference: string;
  kind: 'mcp' | 'cli';
}

function listAgentFiles(): string[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => path.join(AGENTS_DIR, name));
}

function collectReferences(): AgentReference[] {
  const refs: AgentReference[] = [];
  for (const file of listAgentFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    const agent = path.basename(file);
    for (const match of content.matchAll(MCP_TOOL_PATTERN)) {
      refs.push({ agent, reference: match[1], kind: 'mcp' });
    }
    for (const match of content.matchAll(CLI_BUNDLE_PATTERN)) {
      refs.push({ agent, reference: match[1], kind: 'cli' });
    }
  }
  return refs;
}

describe('REGISTERED_MCP_TOOLS mirror ↔ tools.ts source parity (#1374)', () => {
  it('the mirror set matches the registerTool() calls in packages/mcp-server/src/tools.ts', () => {
    // The mirror went stale once already: `features` was registered in
    // tools.ts but missing here, so any agent referencing it would have
    // false-failed the parity tests below. Parse the registrations out of
    // the source file (a file read, not a cross-package import) so drift
    // in either direction fails CI.
    const source = fs.readFileSync(MCP_TOOLS_SOURCE, 'utf8');
    const registered = [...source.matchAll(REGISTER_TOOL_PATTERN)].map((m) => m[1]).toSorted();
    expect(registered.length).toBeGreaterThan(0);
    expect([...REGISTERED_MCP_TOOLS].toSorted()).toEqual(registered);
  });
});

describe('agents/*.md ↔ MCP tool registry parity (#1245)', () => {
  it('every MCP tool name in agent frontmatter exists in the registry', () => {
    const offenders: string[] = [];
    for (const ref of collectReferences()) {
      if (ref.kind !== 'mcp') continue;
      if (!REGISTERED_MCP_TOOLS.has(ref.reference)) {
        offenders.push(`${ref.agent} → mcp__plugin_oss-autopilot_oss-autopilot__${ref.reference}`);
      }
    }
    expect(
      offenders,
      `Agents reference unregistered MCP tools — register them in ` +
        `packages/mcp-server/src/tools.ts or fix the agent frontmatter:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});

describe('agents/*.md ↔ CLI registry parity (#1245)', () => {
  it('every cli.bundle.cjs <command> reference in agent prompts exists in the registry', () => {
    const cliCommandNames = new Set(commands.map((c) => c.name));
    // Plus a few aliases the registry exposes via separate command()
    // declarations: `state` is registered as `state` but exposes `state-show`,
    // `state-sync`, `state-unlink` subcommands; and `parse-issue-list` is the
    // canonical name for the agents' `parse-list` shorthand. Allowlist these.
    cliCommandNames.add('state-show');
    cliCommandNames.add('state-sync');
    cliCommandNames.add('state-unlink');
    cliCommandNames.add('check-setup');
    cliCommandNames.add('parse-list');
    cliCommandNames.add('guidelines-get');
    cliCommandNames.add('guidelines-store');
    cliCommandNames.add('guidelines-reset');
    cliCommandNames.add('guidelines-fetch-corpus');

    const offenders: string[] = [];
    for (const ref of collectReferences()) {
      if (ref.kind !== 'cli') continue;
      if (!cliCommandNames.has(ref.reference)) {
        offenders.push(`${ref.agent} → cli.bundle.cjs ${ref.reference}`);
      }
    }
    expect(
      offenders,
      `Agents invoke unregistered CLI commands — add them to ` +
        `packages/core/src/cli-registry.ts or fix the agent prompt:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});
