import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALLOW_UNCONFIRMED_ENV } from './trust-boundary.js';

const MCP_SERVER_CWD = new URL('..', import.meta.url).pathname;
const UNATTENDED_ENV = 'OSS_AUTOPILOT_UNATTENDED';

/**
 * Run the server in-process under tsx's loader instead of via `npx tsx`.
 * `npx tsx src/index.ts` is three processes deep (npx -> tsx CLI -> forked
 * node); `proc.kill()` only reached npx, so the real server was reparented
 * to PID 1 and kept its port open after every HTTP test (#1870). With
 * `node --import tsx` the spawned PID *is* the server.
 */
const SERVER_COMMAND = process.execPath;
const SERVER_ARGS = ['--import', 'tsx', 'src/index.ts'];

/**
 * Every server child this file spawned directly, checked in afterAll. We
 * hold the ChildProcess rather than a raw PID: Node keeps the pid reserved
 * until it has reaped the child and fired 'exit', so `kill()` on a handle
 * that is still running can never hit a recycled, unrelated process.
 * (Stdio clients are not tracked: StdioClientTransport owns its child and
 * `close()` already escalates stdin-end -> SIGTERM -> SIGKILL.)
 */
const spawned = new Set<ChildProcess>();

/** True until the child's 'exit' event has fired (or spawn itself failed). */
function isRunning(proc: ChildProcess): boolean {
  return proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null;
}

/** How long a server gets to honour SIGTERM before teardown sends SIGKILL. */
const SIGTERM_GRACE_MS = 3000;

/**
 * Wait for a child to exit, escalating to SIGKILL if it ignores SIGTERM for
 * SIGTERM_GRACE_MS. Resolves once the process is gone (or immediately if it
 * already exited), so callers can assert on liveness right after awaiting.
 */
function terminate(proc: ChildProcess): Promise<void> {
  if (!isRunning(proc)) return Promise.resolve();
  return new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      if (isRunning(proc)) proc.kill('SIGKILL');
    }, SIGTERM_GRACE_MS);
    proc.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

// Throwing from afterAll fails the file, which is what we want: a leaked
// server is a bug in the teardown above, not in any single test.
afterAll(() => {
  const leaked = [...spawned].filter((proc) => isRunning(proc));
  for (const proc of leaked) proc.kill('SIGKILL');
  if (leaked.length > 0) {
    const pids = leaked.map((proc) => proc.pid).join(', ');
    throw new Error(`server processes left running after the suite (killed): ${pids}`);
  }
});

// Last resort when the worker exits before afterAll gets to run (a crash or
// bail mid-file). 'exit' handlers must be synchronous, and SIGKILL is.
process.once('exit', () => {
  for (const proc of spawned) {
    if (isRunning(proc)) proc.kill('SIGKILL');
  }
});

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
    command: SERVER_COMMAND,
    args: SERVER_ARGS,
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
  /** Stop the server and resolve once it has actually exited. */
  close: () => Promise<void>;
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
    // An attended run with no write opt-in, whatever the runner's own env says;
    // a test that wants either passes it in `env`.
    const inherited = { ...process.env };
    delete inherited[UNATTENDED_ENV];
    delete inherited[ALLOW_UNCONFIRMED_ENV];
    const proc = spawn(SERVER_COMMAND, [...SERVER_ARGS, ...args], {
      cwd: MCP_SERVER_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...inherited, OSS_AUTOPILOT_MCP_TOKEN_PATH: tokenPath, ...env },
    });
    spawned.add(proc);

    const timeout = setTimeout(() => {
      void terminate(proc);
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
        close: () => terminate(proc),
      });
    };
    proc.stderr!.on('data', onData);

    proc.on('error', (err) => {
      clearTimeout(timeout);
      void terminate(proc);
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

/**
 * Spawn the HTTP server on a random port, retrying with a fresh port when
 * the spawn dies with EADDRINUSE. randomPort()'s 10k-60k range overlaps the
 * OS ephemeral range (Linux: 32768-60999), so on a busy CI runner a
 * collision with an OS-assigned socket kills the spawned server (#1402).
 * Three attempts make a repeat collision negligible; any other failure
 * rethrows immediately.
 */
async function spawnHttpServerOnFreePort(
  env: Record<string, string> = {},
  argsForPort: (port: number) => string[] = (p) => ['--http', `--port=${p}`],
): Promise<HttpServerHandle> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = randomPort();
    try {
      return await spawnHttpServer(argsForPort(port), env);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('EADDRINUSE')) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
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
    expect(tools.length).toBe(37);
    expect(tools.some((t) => t.name === 'daily')).toBe(true);
    expect(tools.some((t) => t.name === 'compliance-score')).toBe(true);
    expect(tools.some((t) => t.name === 'repo-vet')).toBe(true);
    expect(tools.some((t) => t.name === 'features')).toBe(true);
    expect(tools.some((t) => t.name === 'strategy')).toBe(true);
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

  afterEach(async () => {
    if (serverHandle) {
      const handle = serverHandle;
      serverHandle = undefined;
      await handle.close();
    }
  });

  function authHeader(): Record<string, string> {
    if (!serverHandle) throw new Error('serverHandle not initialized');
    return { Authorization: `Bearer ${serverHandle.token}` };
  }

  it('POST /mcp with JSON-RPC initialize returns valid response', async () => {
    serverHandle = await spawnHttpServerOnFreePort();

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
    serverHandle = await spawnHttpServerOnFreePort();

    const res = await httpRequest(serverHandle.port, 'GET', '/');

    expect(res.status).toBe(404);
    expect(res.body).toBe('Not Found');
  });

  it('GET /mcp returns 405', async () => {
    serverHandle = await spawnHttpServerOnFreePort();

    const res = await httpRequest(serverHandle.port, 'GET', '/mcp');

    expect(res.status).toBe(405);
    expect(res.body).toBe('Method Not Allowed');
  });

  it('--port N (space form) works', async () => {
    serverHandle = await spawnHttpServerOnFreePort({}, (p) => ['--http', '--port', String(p)]);

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, authHeader());

    expect(res.status).toBe(200);
  });

  // ── Bearer-token auth (#1028) ───────────────────────────────────

  it('rejects POST /mcp with no Authorization header (401)', async () => {
    serverHandle = await spawnHttpServerOnFreePort();

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY);

    expect(res.status).toBe(401);
    expect(res.body).toBe('Unauthorized');
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('rejects POST /mcp with a malformed Authorization header (401)', async () => {
    serverHandle = await spawnHttpServerOnFreePort();

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, {
      Authorization: 'Basic user:pass',
    });

    expect(res.status).toBe(401);
  });

  it('rejects POST /mcp with a wrong bearer token (401)', async () => {
    serverHandle = await spawnHttpServerOnFreePort();

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, {
      Authorization: `Bearer ${'0'.repeat(64)}`,
    });

    expect(res.status).toBe(401);
  });

  it('persists the token across server restarts', async () => {
    const tokenPath = path.join(os.tmpdir(), `oss-autopilot-mcp-test-persist-${Date.now()}.token`);
    const first = await spawnHttpServerOnFreePort({
      OSS_AUTOPILOT_MCP_TOKEN_PATH: tokenPath,
    });
    const firstToken = first.token;
    await first.close();

    serverHandle = await spawnHttpServerOnFreePort({
      OSS_AUTOPILOT_MCP_TOKEN_PATH: tokenPath,
    });
    expect(serverHandle.token).toBe(firstToken);
  });

  // ── Host-header validation ──────────────────────────────────────

  it('rejects requests with a non-loopback Host header (403)', async () => {
    serverHandle = await spawnHttpServerOnFreePort();

    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, {
      ...authHeader(),
      Host: 'evil.example.com',
    });

    expect(res.status).toBe(403);
    expect(res.body).toBe('Invalid host');
  });

  // ── Body-size cap ───────────────────────────────────────────────

  it('rejects requests whose Content-Length exceeds 1 MiB (413)', async () => {
    serverHandle = await spawnHttpServerOnFreePort();

    // Lie about Content-Length — server should reject before reading the body.
    // Because the server answers without draining the (never-arriving) body,
    // a keep-alive socket would sit mid-request and `httpServer.close()`
    // would wait on it, holding teardown for the whole SIGTERM grace period.
    // `Connection: close` makes the server drop the socket with the response.
    const res = await httpRequest(serverHandle.port, 'POST', '/mcp', INITIALIZE_BODY, {
      ...authHeader(),
      'Content-Length': String(1_048_577),
      Connection: 'close',
    });

    expect(res.status).toBe(413);
    expect(res.body).toBe('Payload Too Large');
  });
});

/** The JSON-RPC messages in a Streamable HTTP response, SSE or plain JSON. */
function rpcMessages(body: string): Array<{ id?: number; result?: Record<string, unknown>; error?: unknown }> {
  const dataLines = body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6));
  return (dataLines.length > 0 ? dataLines : [body]).map((line) => JSON.parse(line));
}

/**
 * The approval gate as the shipped HTTP server runs it (#2054): one
 * NodeStreamableHTTPServerTransport with no session per POST, so a tools/call
 * reaches a server that never saw the host's initialize.
 *
 * The server runs with a fake token and a preload that replaces fetch (the
 * transport Octokit uses) with a recorder that answers 401, so nothing here
 * can reach GitHub, and "nothing was sent" is read from the recorder rather
 * than inferred from a network failure. HOME is the suite's temp HOME.
 */
describe('approval gate over the HTTP transport (#2054)', { timeout: 30_000 }, () => {
  const ISSUE = 'https://github.com/owner/repo/issues/1';
  const WRITERS: Array<[name: string, args: Record<string, unknown>, cli: string]> = [
    ['post', { url: ISSUE, message: 'Thanks, fixed in the last push.' }, 'oss-autopilot post '],
    ['claim', { issueUrl: ISSUE }, 'oss-autopilot claim '],
    ['guidelines-store', { repo: 'owner/repo', content: 'be nice', reviewed: true }, 'oss-autopilot guidelines store '],
    ['guidelines-reset', { repo: 'owner/repo' }, 'oss-autopilot guidelines reset '],
  ];
  const NO_FORM = 'cannot show the user an approval form';

  let dir: string;
  let preload: string;
  let fetchLog: string;
  let serverHandle: HttpServerHandle | undefined;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mcp-http-gate-'));
    preload = path.join(dir, 'record-fetch.mjs');
    fs.writeFileSync(
      preload,
      [
        "import { appendFileSync } from 'node:fs';",
        'globalThis.fetch = async (input, init) => {',
        "  const url = typeof input === 'string' ? input : (input.href ?? input.url);",
        "  const method = init?.method ?? input.method ?? 'GET';",
        '  appendFileSync(process.env.OA_TEST_FETCH_LOG, `${method} ${url}\\n`);',
        "  return new Response('{\"message\":\"Bad credentials\"}', {",
        '    status: 401,',
        "    headers: { 'content-type': 'application/json' },",
        '  });',
        '};',
        '',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    if (serverHandle) {
      const handle = serverHandle;
      serverHandle = undefined;
      await handle.close();
    }
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startServer(env: Record<string, string> = {}): Promise<HttpServerHandle> {
    fetchLog = path.join(dir, `fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    fs.writeFileSync(fetchLog, '');
    serverHandle = await spawnHttpServerOnFreePort({
      GITHUB_TOKEN: 'ghp_fake_token_for_tests_only',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import "${preload}"`.trim(),
      OA_TEST_FETCH_LOG: fetchLog,
      ...env,
    });
    return serverHandle;
  }

  function fetched(): string[] {
    return fs.readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean);
  }

  async function post(handle: HttpServerHandle, message: Record<string, unknown>) {
    const res = await httpRequest(handle.port, 'POST', '/mcp', JSON.stringify({ jsonrpc: '2.0', ...message }), {
      Authorization: `Bearer ${handle.token}`,
    });
    expect(res.status).toBe(200);
    return rpcMessages(res.body);
  }

  async function callTool(handle: HttpServerHandle, name: string, args: Record<string, unknown>) {
    const [reply] = await post(handle, { id: 2, method: 'tools/call', params: { name, arguments: args } });
    expect(reply.id).toBe(2);
    return reply.result as { isError?: boolean; content: Array<{ text: string }> };
  }

  it.each(WRITERS)('%s is refused and sends nothing', async (name, args, cli) => {
    const handle = await startServer();
    const result = await callTool(handle, name, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(NO_FORM);
    expect(result.content[0].text).toContain(cli);
    expect(fetched()).toEqual([]);
  });

  it('is refused even when the host declared a form in an earlier initialize', async () => {
    // The initialize and the call are separate POSTs, each served by a fresh server.
    const handle = await startServer();
    const [init] = await post(handle, {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: { elicitation: {} },
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });
    expect(init.result).toBeDefined();
    const result = await callTool(handle, 'post', WRITERS[0][1]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(NO_FORM);
    expect(fetched()).toEqual([]);
  });

  it('the recorder sees the write once the user opts in, so an empty record means nothing was sent', async () => {
    const handle = await startServer({ [ALLOW_UNCONFIRMED_ENV]: '1' });
    const result = await callTool(handle, 'post', WRITERS[0][1]);
    // The recorder answers 401, so the write itself fails.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(NO_FORM);
    expect(fetched()).toContain('POST https://api.github.com/repos/owner/repo/issues/1/comments');
  });

  it('PROBE sdk clients', async () => {
    const handle = await startServer();
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    const opts = { requestInit: { headers: { Authorization: `Bearer ${handle.token}` } } };
    for (const [label, options] of [
      ['default+form', { capabilities: { elicitation: {} } }],
      ['default+form+manual', { capabilities: { elicitation: {} }, inputRequired: { autoFulfill: false } }],
      ['default-noform', {}],
    ] as const) {
      const client = new Client({ name: 'test-client', version: '1.0.0' }, options as never);
      let asked = 0;
      if ('capabilities' in options) {
        client.setRequestHandler('elicitation/create', async () => {
          asked += 1;
          return { action: 'accept', content: { approve: true } } as never;
        });
      }
      try {
        await client.connect(new StreamableHTTPClientTransport(url, opts));
        console.log('PROBE', label, 'version', client.getNegotiatedProtocolVersion?.());
        const r = await client.callTool({ name: 'post', arguments: WRITERS[0][1] }, { allowInputRequired: true } as never);
        console.log('PROBE', label, 'asked', asked, JSON.stringify(r));
      } catch (e) {
        console.log('PROBE', label, 'threw', String(e));
      } finally {
        await client.close();
      }
    }
    console.log('PROBE fetched', JSON.stringify(fetched()));
  });
});

describe('MCP server invalid port', { timeout: 10_000 }, () => {
  it('exits with error for invalid port', async () => {
    const proc = spawn(SERVER_COMMAND, [...SERVER_ARGS, '--http', '--port=0'], {
      cwd: MCP_SERVER_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    spawned.add(proc);

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
