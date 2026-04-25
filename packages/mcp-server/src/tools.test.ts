import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.js';

/** All 22 tool names that must be registered (untrack and read removed in v4 — #1133). */
const EXPECTED_TOOLS = [
  'daily',
  'status',
  'search',
  'vet',
  'vet-list',
  'track',
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
] as const;

describe('MCP tool registrations', () => {
  let client: Client;
  let tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }>;

  beforeAll(async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const result = await client.listTools();
    tools = result.tools;
  });

  afterAll(async () => {
    await client.close();
  });

  it('registers exactly 22 tools', () => {
    expect(tools).toHaveLength(22);
  });

  it('registers all expected tool names', () => {
    const names = tools.map((t) => t.name).sort();
    const expected = [...EXPECTED_TOOLS].sort();
    expect(names).toEqual(expected);
  });

  it.each(EXPECTED_TOOLS)('tool "%s" has a description', (name) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(tool!.description).toBeTruthy();
    expect(typeof tool!.description).toBe('string');
    expect(tool!.description!.length).toBeGreaterThan(10);
  });

  it.each(EXPECTED_TOOLS)('tool "%s" has an inputSchema', (name) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toBeDefined();
    expect(tool!.inputSchema!.type).toBe('object');
  });

  describe('input schema correctness', () => {
    it('daily has no required properties', () => {
      const tool = tools.find((t) => t.name === 'daily')!;
      const required = (tool.inputSchema as Record<string, unknown>).required;
      expect(required ?? []).toEqual([]);
    });

    it('search has optional maxResults', () => {
      const tool = tools.find((t) => t.name === 'search')!;
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required ?? []).not.toContain('maxResults');
      expect(schema.properties).toHaveProperty('maxResults');
    });

    it('vet requires issueUrl', () => {
      const tool = tools.find((t) => t.name === 'vet')!;
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required).toContain('issueUrl');
    });

    it('track requires prUrl', () => {
      const tool = tools.find((t) => t.name === 'track')!;
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required).toContain('prUrl');
    });

    it('move requires prUrl and target', () => {
      const tool = tools.find((t) => t.name === 'move')!;
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required).toContain('prUrl');
      expect(schema.required).toContain('target');
    });

    it('post requires url and message', () => {
      const tool = tools.find((t) => t.name === 'post')!;
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required).toContain('url');
      expect(schema.required).toContain('message');
    });

    it('status has optional offline flag', () => {
      const tool = tools.find((t) => t.name === 'status')!;
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required ?? []).not.toContain('offline');
      expect(schema.properties).toHaveProperty('offline');
    });

    it('setup has optional reset and set', () => {
      const tool = tools.find((t) => t.name === 'setup')!;
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required ?? []).not.toContain('reset');
      expect(schema.required ?? []).not.toContain('set');
      expect(schema.properties).toHaveProperty('reset');
      expect(schema.properties).toHaveProperty('set');
    });
  });

  describe('annotations', () => {
    // track is read-only in v2: fetches metadata from GitHub, does not persist (#1001).
    // untrack and read v1→v2 stubs were removed in v4 (#1133).
    const readOnlyTools = ['status', 'search', 'vet', 'comments', 'check-setup', 'track'];
    const mutatingTools = [
      'daily',
      'startup',
      'post',
      'claim',
      'config',
      'init',
      'setup',
      'shelve',
      'unshelve',
      'dismiss',
      'undismiss',
      'move',
      'vet-list',
    ];

    it.each(readOnlyTools)('read-only tool "%s" has readOnlyHint: true', (name) => {
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.annotations).toBeDefined();
      expect((tool!.annotations as Record<string, unknown>).readOnlyHint).toBe(true);
    });

    it.each(mutatingTools)('mutating tool "%s" has readOnlyHint: false', (name) => {
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.annotations).toBeDefined();
      expect((tool!.annotations as Record<string, unknown>).readOnlyHint).toBe(false);
    });

    // #1053 — tools that post public content under the user's identity must
    // carry destructiveHint: true so MCP clients flag them for confirmation,
    // and the description must warn the LLM that the action is irreversible.
    it.each(['post', 'claim'])('destructive tool "%s" has destructiveHint: true', (name) => {
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect((tool!.annotations as Record<string, unknown>).destructiveHint).toBe(true);
    });

    it.each(['post', 'claim'])('destructive tool "%s" description warns about irreversibility', (name) => {
      const tool = tools.find((t) => t.name === name);
      expect(tool!.description).toMatch(/irreversible/i);
    });
  });

  // ── #1053 input-schema validation at the tool boundary ────────────────

  describe('URL input validation', () => {
    it('rejects a non-GitHub URL on `post` at the schema layer', async () => {
      // Zod validation failures surface as isError:true results via the MCP
      // SDK's callTool path — not as thrown rejections.
      const result = await client.callTool({
        name: 'post',
        arguments: { url: 'https://example.com/comment', message: 'hi' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toMatch(/github/i);
    });

    it('rejects a malformed PR URL on `track` at the schema layer', async () => {
      const result = await client.callTool({
        name: 'track',
        arguments: { prUrl: 'not-a-url' },
      });
      expect(result.isError).toBe(true);
    });

    it('rejects an issue URL where the tool expects a PR URL', async () => {
      // `shelve` requires a PR URL; passing an issue URL should fail schema
      // validation before the tool handler runs.
      const result = await client.callTool({
        name: 'shelve',
        arguments: { prUrl: 'https://github.com/owner/repo/issues/1' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toMatch(/pr/i);
    });
  });

  describe('config key enum', () => {
    it('rejects an unknown config key at the schema layer', async () => {
      const result = await client.callTool({
        name: 'config',
        arguments: { key: 'totallyMadeUpKey', value: 'x' },
      });
      expect(result.isError).toBe(true);
    });

    it('accepts a known config key (via registry)', async () => {
      // We don't actually care about the result — just that the schema
      // doesn't reject. The mocked runConfig is fine with anything.
      const result = await client.callTool({
        name: 'config',
        arguments: { key: 'username', value: 'example-user' },
      });
      expect(result.isError).not.toBe(true);
    });
  });
});
