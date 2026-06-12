import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getStatePath } from '@oss-autopilot/core';
import { createServer } from './server.js';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_JSON_PATH = path.resolve(TESTS_DIR, '../../../hooks/hooks.json');

/** All registered tool names (untrack and read removed in v4 — #1133;
 * compliance-score added in #1245). */
const EXPECTED_TOOLS = [
  'daily',
  'status',
  'search',
  'features',
  'vet',
  'vet-list',
  'verify-issue',
  'track',
  'compliance-score',
  'repo-vet',
  'strategy',
  'comments',
  'post',
  'claim',
  'config',
  'init',
  'setup',
  'check-setup',
  'startup',
  'dismiss',
  'undismiss',
  'move',
  'state-show',
  'state-sync',
  'state-unlink',
  'guidelines-list',
  'guidelines-get',
  'guidelines-store',
  'guidelines-reset',
  'guidelines-fetch-corpus',
] as const;

describe('MCP tool registrations', () => {
  let client: Client;
  let tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }>;

  // Snapshot state.json bytes before any test runs so the regression guard
  // below can prove no test in this file mutated the user's real state file
  // (#1342). Stored as { exists, bytes } so we cover both "fresh install
  // (no state file yet)" and "existing user with config".
  let stateSnapshot: { exists: boolean; bytes: Buffer | null } = { exists: false, bytes: null };

  beforeAll(async () => {
    try {
      const statePath = getStatePath();
      stateSnapshot = fs.existsSync(statePath)
        ? { exists: true, bytes: fs.readFileSync(statePath) }
        : { exists: false, bytes: null };
    } catch {
      // getStatePath() can throw before setup; treat as absent.
      stateSnapshot = { exists: false, bytes: null };
    }

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

  it('registers exactly 30 tools', () => {
    expect(tools).toHaveLength(30);
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
    const readOnlyTools = [
      'status',
      'search',
      'vet',
      'comments',
      'check-setup',
      'track',
      'compliance-score',
      'repo-vet',
    ];
    const mutatingTools = [
      'daily',
      'startup',
      'post',
      'claim',
      'config',
      'init',
      'setup',
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

  // ── hooks.json guard-public-posts matcher consistency (#1302 item 2) ──
  //
  // The guard-public-posts.sh hook fires on a PreToolUse matcher in
  // hooks/hooks.json. Today the matcher is hand-curated; this contract
  // makes it drift-resistant by pinning it to the tool registry's
  // `destructiveHint` annotation: every plugin tool with
  // `destructiveHint: true` that produces an externally-visible event
  // MUST be in the matcher, and every plugin tool in the matcher MUST
  // carry the destructiveHint annotation. New gating tools therefore get
  // covered automatically — adding a tool with `destructiveHint: true`
  // and forgetting to update the matcher fails CI.
  //
  // Tools that are destructive to LOCAL state but don't post publicly
  // (the canonical example today is `guidelines-reset`, which tombstones
  // the user's gist file) are listed below as explicit exclusions. The
  // exclusion is a rare exception, not the default — the bar is "this
  // tool is destructive but does not produce an externally-visible
  // GitHub event under the user's identity."
  describe('hooks.json guard-public-posts matcher (#1302 item 2)', () => {
    /** Plugin tools with destructiveHint:true that operate on local state only. */
    const LOCAL_ONLY_DESTRUCTIVE = new Set(['guidelines-reset']);
    const PLUGIN_TOOL_PREFIX = 'mcp__plugin_oss-autopilot_oss-autopilot__';

    function loadGuardMatcher(): string {
      const hooksJson = JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, 'utf8'));
      const preToolUse = hooksJson.hooks.PreToolUse as Array<{
        matcher: string;
        hooks: Array<{ command: string }>;
      }>;
      const guardEntry = preToolUse.find((entry) =>
        entry.hooks.some((h) => h.command.includes('guard-public-posts.sh')),
      );
      if (!guardEntry) {
        throw new Error('hooks.json has no PreToolUse entry pointing at guard-public-posts.sh');
      }
      return guardEntry.matcher;
    }

    function pluginToolsInMatcher(matcher: string): string[] {
      return matcher
        .split('|')
        .map((m) => m.trim())
        .filter((m) => m.startsWith(PLUGIN_TOOL_PREFIX))
        .map((m) => m.slice(PLUGIN_TOOL_PREFIX.length));
    }

    it('every destructive plugin tool that posts publicly is in the matcher', () => {
      const matcher = loadGuardMatcher();
      const missing: string[] = [];
      for (const tool of tools) {
        const ann = (tool.annotations ?? {}) as Record<string, unknown>;
        if (ann.destructiveHint !== true) continue;
        if (LOCAL_ONLY_DESTRUCTIVE.has(tool.name)) continue;
        const fullName = `${PLUGIN_TOOL_PREFIX}${tool.name}`;
        if (!matcher.includes(fullName)) missing.push(tool.name);
      }
      expect(missing, `Tools missing from guard-public-posts matcher: ${missing.join(', ')}`).toEqual([]);
    });

    it('every plugin tool in the matcher has destructiveHint:true', () => {
      const matcher = loadGuardMatcher();
      const matchedNames = pluginToolsInMatcher(matcher);
      for (const name of matchedNames) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, `Matcher references "${name}" but no such tool is registered`).toBeDefined();
        const ann = (tool!.annotations ?? {}) as Record<string, unknown>;
        expect(
          ann.destructiveHint,
          `"${name}" is in the matcher but lacks destructiveHint:true — either add the annotation or remove from matcher`,
        ).toBe(true);
      }
    });

    it('LOCAL_ONLY_DESTRUCTIVE entries actually exist as registered tools with destructiveHint:true', () => {
      // Guard against the exclusion list going stale (a tool gets renamed
      // or de-flagged but still appears here).
      for (const name of LOCAL_ONLY_DESTRUCTIVE) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, `LOCAL_ONLY_DESTRUCTIVE entry "${name}" is not a registered tool`).toBeDefined();
        const ann = (tool!.annotations ?? {}) as Record<string, unknown>;
        expect(
          ann.destructiveHint,
          `LOCAL_ONLY_DESTRUCTIVE entry "${name}" must have destructiveHint:true (or remove from list)`,
        ).toBe(true);
      }
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
      // `move` requires a PR URL; passing an issue URL should fail schema
      // validation before the tool handler runs.
      const result = await client.callTool({
        name: 'move',
        arguments: { prUrl: 'https://github.com/owner/repo/issues/1', target: 'shelved' },
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

    it('accepts a known config key (via registry)', () => {
      // Inspect the registered schema rather than invoking the tool. The
      // earlier version of this test called `client.callTool` with
      // `key: 'username', value: 'alice-dev'` and a comment claiming the
      // runConfig was "mocked" — but it never was, so the call reached the
      // real `runConfig` and wrote `githubUsername: alice-dev` to the user's
      // actual `~/.oss-autopilot/state.json` every time the suite ran (#1342).
      // The intent — "the registry-derived enum admits a known key" — is
      // fully served by reading the published schema.
      const tool = tools.find((t) => t.name === 'config')!;
      const schema = tool.inputSchema as { properties?: { key?: { enum?: string[] } } };
      const allowedKeys = schema.properties?.key?.enum;
      expect(allowedKeys).toBeDefined();
      expect(allowedKeys).toContain('username');
    });
  });

  // Declared last so it runs after every other test in this file. Catches
  // future regressions where a test in this file invokes a tool that ends up
  // mutating the user's real state.json (#1342).
  describe('regression guard', () => {
    it("does not mutate the user's ~/.oss-autopilot/state.json", () => {
      const statePath = getStatePath();
      const stillExists = fs.existsSync(statePath);
      expect(stillExists).toBe(stateSnapshot.exists);
      if (stateSnapshot.exists && stillExists) {
        const after = fs.readFileSync(statePath);
        expect(after.equals(stateSnapshot.bytes!)).toBe(true);
      }
    });
  });
});
