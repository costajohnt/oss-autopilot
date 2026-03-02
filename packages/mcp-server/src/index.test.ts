import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Create a stdio client connected to a fresh MCP server process. */
async function createStdioClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    cwd: new URL('..', import.meta.url).pathname,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('MCP server stdio transport', () => {
  let client: Client;

  afterEach(async () => {
    if (client) {
      await client.close();
    }
  });

  it('lists tools via stdio', async () => {
    client = await createStdioClient();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(21);
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
