import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureHttpToken, validateBearerToken, isValidHost, resolveTokenPath } from './auth.js';

function makeTmpTokenPath(): string {
  return path.join(
    os.tmpdir(),
    `oss-autopilot-mcp-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.token`,
  );
}

describe('auth.resolveTokenPath', () => {
  const originalEnv = process.env.OSS_AUTOPILOT_MCP_TOKEN_PATH;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OSS_AUTOPILOT_MCP_TOKEN_PATH;
    else process.env.OSS_AUTOPILOT_MCP_TOKEN_PATH = originalEnv;
  });

  it('uses OSS_AUTOPILOT_MCP_TOKEN_PATH when set', () => {
    process.env.OSS_AUTOPILOT_MCP_TOKEN_PATH = '/tmp/custom.token';
    expect(resolveTokenPath()).toBe('/tmp/custom.token');
  });

  it('defaults to ~/.oss-autopilot/mcp.token', () => {
    delete process.env.OSS_AUTOPILOT_MCP_TOKEN_PATH;
    expect(resolveTokenPath()).toBe(path.join(os.homedir(), '.oss-autopilot', 'mcp.token'));
  });

  it('ignores an empty OSS_AUTOPILOT_MCP_TOKEN_PATH', () => {
    process.env.OSS_AUTOPILOT_MCP_TOKEN_PATH = '';
    expect(resolveTokenPath()).toBe(path.join(os.homedir(), '.oss-autopilot', 'mcp.token'));
  });
});

describe('auth.ensureHttpToken', () => {
  let tokenPath: string;

  beforeEach(() => {
    tokenPath = makeTmpTokenPath();
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tokenPath);
    } catch {
      /* already gone */
    }
  });

  it('generates a fresh 64-char hex token when no file exists', async () => {
    const { token, path: p, freshlyGenerated } = await ensureHttpToken(tokenPath);
    expect(p).toBe(tokenPath);
    expect(freshlyGenerated).toBe(true);
    expect(token).toMatch(/^[\da-f]{64}$/);
  });

  it('persists the token between calls', async () => {
    const first = await ensureHttpToken(tokenPath);
    const second = await ensureHttpToken(tokenPath);
    expect(second.freshlyGenerated).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it('writes the token file with 0600 permissions', async () => {
    await ensureHttpToken(tokenPath);
    const stat = fs.statSync(tokenPath);
    // POSIX mode bits — lower 9 bits are rwx user/group/other.
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the containing directory when missing', async () => {
    const nestedDir = path.join(os.tmpdir(), `oss-autopilot-mcp-auth-nested-${Date.now()}`);
    const nestedPath = path.join(nestedDir, 'mcp.token');
    try {
      const result = await ensureHttpToken(nestedPath);
      expect(fs.existsSync(nestedPath)).toBe(true);
      expect(result.token.length).toBe(64);
    } finally {
      try {
        fs.rmSync(nestedDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('tightens permissions when the pre-existing token file is world-readable', async () => {
    // Simulate a user or attacker who relaxed perms to 0644 between runs.
    // ensureHttpToken should reload the token AND re-chmod to 0600.
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, 'a'.repeat(64) + '\n', { mode: 0o644 });
    fs.chmodSync(tokenPath, 0o644); // Guard against umask on some systems.

    const result = await ensureHttpToken(tokenPath);
    expect(result.freshlyGenerated).toBe(false);
    expect(result.token).toBe('a'.repeat(64));

    const mode = fs.statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('auth.validateBearerToken', () => {
  const expected = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('accepts a matching bearer header', () => {
    expect(validateBearerToken(`Bearer ${expected}`, expected)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(validateBearerToken(undefined, expected)).toBe(false);
  });

  it('rejects a header missing the Bearer prefix', () => {
    expect(validateBearerToken(expected, expected)).toBe(false);
  });

  it('rejects a wrong token of the same length', () => {
    expect(validateBearerToken(`Bearer ${'f'.repeat(64)}`, expected)).toBe(false);
  });

  it('rejects a wrong token of a different length (avoids timingSafeEqual throw)', () => {
    expect(validateBearerToken('Bearer short', expected)).toBe(false);
  });

  it('handles surrounding whitespace', () => {
    expect(validateBearerToken(`Bearer  ${expected}  `, expected)).toBe(true);
  });

  it('accepts case-insensitive Bearer scheme per RFC 7235', () => {
    expect(validateBearerToken(`bearer ${expected}`, expected)).toBe(true);
    expect(validateBearerToken(`BEARER ${expected}`, expected)).toBe(true);
    expect(validateBearerToken(`BeArEr ${expected}`, expected)).toBe(true);
  });

  it('rejects authentication when the expected token is empty (defense in depth)', () => {
    // crypto.timingSafeEqual('', '') returns true, which would open auth
    // if a future caller accidentally passed an empty expected token.
    expect(validateBearerToken('Bearer ', '')).toBe(false);
    expect(validateBearerToken('Bearer anything', '')).toBe(false);
    expect(validateBearerToken('', '')).toBe(false);
  });
});

describe('auth.isValidHost', () => {
  it('accepts 127.0.0.1:<port>', () => {
    expect(isValidHost('127.0.0.1:3001', 3001)).toBe(true);
  });

  it('accepts localhost:<port>', () => {
    expect(isValidHost('localhost:3001', 3001)).toBe(true);
  });

  it('rejects mismatched port', () => {
    expect(isValidHost('127.0.0.1:9999', 3001)).toBe(false);
  });

  it('rejects a rebound attacker hostname', () => {
    expect(isValidHost('evil.example.com:3001', 3001)).toBe(false);
  });

  it('rejects missing host header', () => {
    expect(isValidHost(undefined, 3001)).toBe(false);
  });

  it('does NOT accept oss.localhost (stricter than dashboard server)', () => {
    // The MCP HTTP transport is for MCP clients (Cursor, Claude Desktop,
    // Codex) which connect via 127.0.0.1 or localhost only. `oss.localhost`
    // is a dashboard-specific affordance and is not in the MCP allow-list.
    expect(isValidHost('oss.localhost:3001', 3001)).toBe(false);
  });
});
