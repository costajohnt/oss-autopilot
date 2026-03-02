import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.js';

/** All 21 tool names that must be registered. */
const EXPECTED_TOOLS = [
  'daily',
  'status',
  'search',
  'vet',
  'track',
  'untrack',
  'read',
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
  'snooze',
  'unsnooze',
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

  it('registers exactly 21 tools', () => {
    expect(tools).toHaveLength(21);
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

    it('snooze requires prUrl and reason, days is optional', () => {
      const tool = tools.find((t) => t.name === 'snooze')!;
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required).toContain('prUrl');
      expect(schema.required).toContain('reason');
      expect(schema.required).not.toContain('days');
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

    it('read has optional prUrl and all', () => {
      const tool = tools.find((t) => t.name === 'read')!;
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required ?? []).not.toContain('prUrl');
      expect(schema.required ?? []).not.toContain('all');
      expect(schema.properties).toHaveProperty('prUrl');
      expect(schema.properties).toHaveProperty('all');
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
    const readOnlyTools = ['status', 'search', 'vet', 'comments', 'check-setup'];
    const mutatingTools = [
      'daily',
      'startup',
      'track',
      'untrack',
      'read',
      'post',
      'claim',
      'config',
      'init',
      'setup',
      'shelve',
      'unshelve',
      'dismiss',
      'undismiss',
      'snooze',
      'unsnooze',
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

    it('untrack has destructiveHint: true', () => {
      const tool = tools.find((t) => t.name === 'untrack')!;
      expect((tool.annotations as Record<string, unknown>).destructiveHint).toBe(true);
    });
  });
});
