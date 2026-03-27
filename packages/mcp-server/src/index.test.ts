import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';

const MCP_SERVER_CWD = new URL('..', import.meta.url).pathname;

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
});

/** Create a stdio client connected to a fresh MCP server process. */
async function createStdioClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    cwd: MCP_SERVER_CWD,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/** Get a random high port to avoid conflicts in parallel test runs. */
function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

/** Spawn an HTTP MCP server and wait for it to be listening. */
function spawnHttpServer(args: string[]): Promise<{ port: number; proc: ChildProcess; close: () => void }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', 'src/index.ts', ...args], {
      cwd: MCP_SERVER_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('HTTP server did not start within 10s'));
    }, 10_000);

    let stderrData = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrData += chunk.toString();
      // Server prints "listening on http://127.0.0.1:<port>/mcp" when ready
      const match = stderrData.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
      if (match) {
        clearTimeout(timeout);
        const port = parseInt(match[1], 10);
        resolve({
          port,
          proc,
          close: () => proc.kill('SIGTERM'),
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(new Error(`Server exited with code ${code}: ${stderrData}`));
      }
    });
  });
}

/** Make an HTTP request and return the response status + body. */
function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: body
          ? {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'Content-Length': Buffer.byteLength(body),
            }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('MCP server stdio transport', { timeout: 30_000 }, () => {
  let client: Client;

  afterEach(async () => {
    if (client) {
      await client.close();
    }
  });

  it('lists tools via stdio', async () => {
    client = await createStdioClient();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(23);
    expect(tools.some((t) => t.name === 'daily')).toBe(true);
  });

  it('lists resources via stdio', async () => {
    client = await createStdioClient();
    const { resources } = await client.listResources();
    expect(resources.length).toBeGreaterThanOrEqual(4);
  });

  it('lists prompts via stdio', async () => {
    client = await createStdioClient();
    const { prompts } = await client.listPrompts();
    expect(prompts.length).toBe(3);
  });
});

describe('MCP server HTTP transport', { timeout: 30_000 }, () => {
  let serverHandle: { port: number; proc: ChildProcess; close: () => void } | undefined;

  afterEach(() => {
    if (serverHandle) {
      serverHandle.close();
      serverHandle = undefined;
    }
  });

  it('POST /mcp with JSON-RPC initialize returns valid response', async () => {
    const port = randomPort();
    serverHandle = await spawnHttpServer(['--http', `--port=${port}`]);

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY);

    expect(res.status).toBe(200);
    // Streamable HTTP transport returns SSE — extract JSON from "data:" lines
    const dataLines = res.body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6));
    expect(dataLines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(dataLines[0]);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result).toBeDefined();
    expect(parsed.result.serverInfo.name).toBe('oss-autopilot');
  });

  it('GET / returns 404', async () => {
    const port = randomPort();
    serverHandle = await spawnHttpServer(['--http', `--port=${port}`]);

    const res = await httpRequest(serverHandle.port, 'GET', '/');

    expect(res.status).toBe(404);
    expect(res.body).toBe('Not Found');
  });

  it('GET /mcp returns 405', async () => {
    const port = randomPort();
    serverHandle = await spawnHttpServer(['--http', `--port=${port}`]);

    const res = await httpRequest(serverHandle.port, 'GET', '/mcp');

    expect(res.status).toBe(405);
    expect(res.body).toBe('Method Not Allowed');
  });

  it('--port N (space form) works', async () => {
    const port = randomPort();
    serverHandle = await spawnHttpServer(['--http', '--port', String(port)]);

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY);

    expect(res.status).toBe(200);
  });
});

describe('MCP server invalid port', { timeout: 10_000 }, () => {
  it('exits with error for invalid port', async () => {
    const proc = spawn('npx', ['tsx', 'src/index.ts', '--http', '--port=0'], {
      cwd: MCP_SERVER_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on('exit', (code) => resolve(code));
    });

    expect(exitCode).not.toBe(0);
  });
});

describe('index.ts re-exports', () => {
  it('exports createServer', async () => {
    const { createServer } = await import('./index.js');
    expect(typeof createServer).toBe('function');
  });

  it('exports registerTools', async () => {
    const { registerTools } = await import('./index.js');
    expect(typeof registerTools).toBe('function');
  });

  it('exports registerResources', async () => {
    const { registerResources } = await import('./index.js');
    expect(typeof registerResources).toBe('function');
  });

  it('exports registerPrompts', async () => {
    const { registerPrompts } = await import('./index.js');
    expect(typeof registerPrompts).toBe('function');
  });
});
