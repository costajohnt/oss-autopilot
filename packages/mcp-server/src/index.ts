#!/usr/bin/env node
/**
 * OSS Autopilot MCP Server
 * Entry point supporting stdio (default) and Streamable HTTP transports.
 */
import { createServer } from './server.js';

export { createServer } from './server.js';
export { registerTools } from './tools.js';
export { registerResources } from './resources.js';
export { registerPrompts } from './prompts.js';

async function main() {
  const args = process.argv.slice(2);
  const httpMode = args.includes('--http');

  if (httpMode) {
    // Parse port from --port=N or --port N
    const portArg = args.find((a) => a.startsWith('--port='));
    const portIdx = args.indexOf('--port');
    let port = 3001;
    if (portArg) {
      port = parseInt(portArg.split('=')[1], 10);
    } else if (portIdx >= 0) {
      port = parseInt(args[portIdx + 1], 10);
    }

    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${port}. Must be 1-65535.`);
      process.exit(1);
    }

    const { createServer: createHttpServer } = await import('node:http');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

    const httpServer = createHttpServer(async (req, res) => {
      if (req.url !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
      }
      // Stateless mode: fresh server + transport per request to avoid
      // race conditions from concurrent connect() calls on a shared instance.
      const server = createServer();
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error('[MCP] Request error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      } finally {
        await server.close();
      }
    });

    const shutdown = () => {
      httpServer.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    httpServer.listen(port, '127.0.0.1', () => {
      console.error(`OSS Autopilot MCP server listening on http://127.0.0.1:${port}/mcp`);
    });
  } else {
    // Default: stdio transport
    const server = createServer();
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

// Only run main() when this is the entry point, not when imported as a module
const ENTRY_SUFFIXES = [
  '/mcp-server/src/index.ts',
  '/mcp-server/dist/index.js',
  '/mcp-server.bundle.cjs',
  '/oss-autopilot-mcp',
];
const isMain = process.argv[1] && ENTRY_SUFFIXES.some((s) => process.argv[1].endsWith(s));

if (isMain) {
  main().catch((err) => {
    console.error('MCP server fatal error:', err);
    process.exit(1);
  });
}
