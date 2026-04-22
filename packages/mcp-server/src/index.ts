#!/usr/bin/env node
/**
 * OSS Autopilot MCP Server
 * Entry point supporting stdio (default) and Streamable HTTP transports.
 */
import { createServer } from './server.js';
import { ensureHttpToken, validateBearerToken, isValidHost } from './auth.js';

export { createServer } from './server.js';
export { registerTools } from './tools.js';
export { registerResources } from './resources.js';
export { registerPrompts } from './prompts.js';

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

export async function main() {
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

    // Ensure a bearer token exists before accepting any requests (#1028).
    const tokenInfo = await ensureHttpToken();

    const { createServer: createHttpServer } = await import('node:http');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

    const httpServer = createHttpServer(async (req, res) => {
      // DNS-rebinding defense: reject Host headers outside the loopback
      // allow-list BEFORE doing any other work (#1028).
      if (!isValidHost(req.headers['host'], port)) {
        res.writeHead(403);
        res.end('Invalid host');
        return;
      }

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

      // Require every request to declare a numeric Content-Length within the
      // cap. Rejecting missing / non-numeric / chunked up-front avoids
      // relying on the MCP SDK's transport-internal limits (which are not
      // documented to exist for the streamable HTTP POST reader) and closes
      // the "send chunked to skip the cap" bypass noted in #1028 review.
      const contentLengthHeader = req.headers['content-length'];
      const contentLength = typeof contentLengthHeader === 'string' ? parseInt(contentLengthHeader, 10) : NaN;
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
        res.writeHead(413);
        res.end('Payload Too Large');
        return;
      }

      // Bearer-token auth: every /mcp request must carry Authorization.
      if (!validateBearerToken(req.headers['authorization'], tokenInfo.token)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="oss-autopilot-mcp"' });
        res.end('Unauthorized');
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
      // Drain in-flight requests before exiting. Hard-exit after 5s so a
      // hung client cannot prevent shutdown.
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    httpServer.listen(port, '127.0.0.1', () => {
      console.error(`OSS Autopilot MCP server listening on http://127.0.0.1:${port}/mcp`);
      console.error(
        `Authentication: Bearer token${tokenInfo.freshlyGenerated ? ' (newly generated)' : ''} at ${tokenInfo.path}`,
      );
      console.error('Clients must send: Authorization: Bearer <token-file-contents>');
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
export const ENTRY_SUFFIXES = [
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
