/**
 * MCP server factory for OSS Autopilot.
 *
 * Creates and configures a McpServer instance with all tools, resources,
 * and prompts registered.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

const version: string = (() => {
  try {
    // In CJS bundle: __dirname is defined by esbuild
    // In ESM (dev via tsx): use import.meta.url
    const dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch (e) {
    console.error('[MCP] Failed to read package version:', e);
    return '0.0.0';
  }
})();

/**
 * Create a fully configured MCP server with all tools, resources, and prompts registered.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'oss-autopilot',
    version,
  });

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}
