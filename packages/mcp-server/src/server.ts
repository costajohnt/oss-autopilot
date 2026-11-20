/**
 * MCP server factory for OSS Autopilot.
 *
 * Creates and configures a McpServer instance with all tools, resources,
 * and prompts registered.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

const version: string = (() => {
  try {
    // In CJS bundle: __dirname is defined by esbuild
    // In ESM (dev via tsx): use import.meta.url
    const dir = typeof __dirname === 'undefined' ? dirname(fileURLToPath(import.meta.url)) : __dirname;
    const pkg = JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf8'));
    return pkg.version;
  } catch (e) {
    console.error('[MCP] Failed to read package version:', e);
    return '0.0.0';
  }
})();

/** How long the user has to answer an approval form (trust-boundary.ts). */
export const APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Create a fully configured MCP server with all tools, resources, and prompts registered.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'oss-autopilot',
      version,
    },
    // An approval form left unanswered refuses the call after two minutes
    // ("Request timed out") instead of holding the request open for ten.
    { inputRequired: { roundTimeoutMs: APPROVAL_TIMEOUT_MS } },
  );

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}
