/**
 * Shared source-parser for the MCP tool registry, used by the repo-contract
 * tests (agents-contract.test.ts, docs-contract.test.ts).
 *
 * One definition instead of per-test copies: duplicated parsers are the
 * mirror-drift class (#1374) — if tools.ts ever adopts a registration shape
 * one copy matches and the other doesn't, the divergence is silent. This
 * module lives under src/test-lib/, which is excluded from the package
 * build (tsconfig) and from coverage (vitest config); it must never be
 * imported by production code.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '../../../..');

export const MCP_TOOLS_SOURCE = path.join(REPO_ROOT, 'packages/mcp-server/src/tools.ts');

export const REGISTER_TOOL_PATTERN = /registerTool\(\s*'([a-z][\da-z-]*)'/g;

/**
 * Parse the registered MCP tool names out of the tools.ts source.
 * Throws (via the caller's assertions) being preferable to returning a
 * silently-empty list, callers should assert `length > 0`.
 */
export function parseRegisteredTools(): string[] {
  const source = fs.readFileSync(MCP_TOOLS_SOURCE, 'utf8');
  return [...source.matchAll(REGISTER_TOOL_PATTERN)].map((m) => m[1]);
}
