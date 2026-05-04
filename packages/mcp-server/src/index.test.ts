import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  return 10_000 + Math.floor(Math.random() * 50_000);
}

/** Spawn an HTTP MCP server and wait for it to be listening. Returns the
 * resolved bearer token from the test-isolated token file alongside the
 * server handle. */
interface HttpServerHandle {
  port: number;
  proc: ChildProcess;
  close: () => void;
  token: string;
  tokenPath: string;
}

function spawnHttpServer(args: string[], env: Record<string, string> = {}): Promise<HttpServerHandle> {
  return new Promise((resolve, reject) => {
    // Per-server token path so concurrent tests don't collide with each
    // other or with the user's real ~/.oss-autopilot/mcp.token.
    const tokenPath =
      env.OSS_AUTOPILOT_MCP_TOKEN_PATH ??
      path.join(os.tmpdir(), `oss-autopilot-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.token`);
    const proc = spawn('npx', ['tsx', 'src/index.ts', ...args], {
      cwd: MCP_SERVER_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OSS_AUTOPILOT_MCP_TOKEN_PATH: tokenPath, ...env },
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('HTTP server did not start within 10s'));
    }, 10_000);

    let stderrData = '';
    let resolved = false;
    const onData = (chunk: Buffer) => {
      stderrData += chunk.toString();
      if (resolved) return;
      // Server prints "listening on http://127.0.0.1:<port>/mcp" when ready
      const match = stderrData.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
      if (!match) return;
      resolved = true;
      clearTimeout(timeout);
      proc.stderr!.off('data', onData);
      const port = parseInt(match[1], 10);
      // Token file was written synchronously by ensureHttpToken before
      // httpServer.listen, so it must exist by the time the banner prints.
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      resolve({
        port,
        proc,
        token,
        tokenPath,
        close: () => {
          proc.kill('SIGTERM');
        },
      });
    };
    proc.stderr!.on('data', onData);

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
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const baseHeaders: Record<string, string | number> = body
      ? {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body),
        }
      : {};
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { ...baseHeaders, ...extraHeaders },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: data,
            headers: res.headers as Record<string, string | string[] | undefined>,
          }),
        );
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
    expect(tools.length).toBe(26);
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
    expect(prompts.length).toBe(4);
  });
});

describe('MCP server HTTP transport', { timeout: 30_000 }, () => {
  let serverHandle: HttpServerHandle | undefined;

  afterEach(() => {
    if (serverHandle) {
      serverHandle.close();
      serverHandle = undefined;
    }
  });

  function authHeader(): Record<string, string> {
    if (!serverHandle) throw new Error('serverHandle not initialized');
    return { Authorization: `Bearer ${serverHandle.token}` };
  }

  it('POST /mcp with JSON-RPC initialize returns valid response', async () => {
    const port = randomPort();
    serverHandle = await spawnHttpServer(['--http', `--port=${port}`]);

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, authHeader());

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

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, authHeader());

    expect(res.status).toBe(200);
  });

  // ── Bearer-token auth (#1028) ───────────────────────────────────

  it('rejects POST /mcp with no Authorization header (401)', async () => {
    const port = randomPort();
    serverHandle = await spawnHttpServer(['--http', `--port=${port}`]);

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY);

    expect(res.status).toBe(401);
    expect(res.body).toBe('Unauthorized');
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('rejects POST /mcp with a malformed Authorization header (401)', async () => {
    const port = randomPort();
    serverHandle = await spawnHttpServer(['--http', `--port=${port}`]);

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, {
      Authorization: 'Basic user:pass',
    });

    expect(res.status).toBe(401);
  });

  it('rejects POST /mcp with a wrong bearer token (401)', async () => {
    const port = randomPort();
    serverHandle = await spawnHttpServer(['--http', `--port=${port}`]);

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, {
      Authorization: `Bearer ${'0'.repeat(64)}`,
    });

    expect(res.status).toBe(401);
  });

  it('persists the token across server restarts', async () => {
    const tokenPath = path.join(os.tmpdir(), `oss-autopilot-mcp-test-persist-${Date.now()}.token`);
    const port1 = randomPort();
    const first = await spawnHttpServer(['--http', `--port=${port1}`], {
      OSS_AUTOPILOT_MCP_TOKEN_PATH: tokenPath,
    });
    const firstToken = first.token;
    first.proc.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));

    const port2 = randomPort();
    serverHandle = await spawnHttpServer(['--http', `--port=${port2}`], {
      OSS_AUTOPILOT_MCP_TOKEN_PATH: tokenPath,
    });
    expect(serverHandle.token).toBe(firstToken);
  });

  // ── Host-header validation ──────────────────────────────────────

  it('rejects requests with a non-loopback Host header (403)', async () => {
    const port = randomPort();
    serverHandle = await spawnHttpServer(['--http', `--port=${port}`]);

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, {
      ...authHeader(),
      Host: 'evil.example.com',
    });

    expect(res.status).toBe(403);
    expect(res.body).toBe('Invalid host');
  });

  // ── Body-size cap ───────────────────────────────────────────────

  it('rejects requests whose Content-Length exceeds 1 MiB (413)', async () => {
    const port = randomPort();
    serverHandle = await spawnHttpServer(['--http', `--port=${port}`]);

    // Lie about Content-Length — server should reject before reading the body.
    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, {
      ...authHeader(),
      'Content-Length': String(1_048_577),
    });

    expect(res.status).toBe(413);
    expect(res.body).toBe('Payload Too Large');
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
