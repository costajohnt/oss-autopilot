/**
 * HTTP transport authentication — bearer-token auth.
 *
 * A 32-byte random token is generated on the first `--http` startup and
 * stored at `~/.oss-autopilot/mcp.token` (or the `OSS_AUTOPILOT_MCP_TOKEN_PATH`
 * env-var override) with `0600` permissions. Every HTTP request must carry
 * `Authorization: Bearer <token>` or it is rejected 401.
 *
 * stdio transport has no auth — it inherits the parent process identity.
 * See issue #1028.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const TOKEN_FILE_MODE = 0o600;
const TOKEN_DIR_MODE = 0o700;
const TOKEN_BYTES = 32; // → 64 hex chars

/**
 * Resolve the token file path. Uses OSS_AUTOPILOT_MCP_TOKEN_PATH when set
 * (test isolation + custom-path support); otherwise the default under the
 * user's home directory.
 */
export function resolveTokenPath(): string {
  const override = process.env.OSS_AUTOPILOT_MCP_TOKEN_PATH;
  if (override && override.length > 0) return override;
  return path.join(homedir(), '.oss-autopilot', 'mcp.token');
}

/**
 * Load the token from disk. Returns null when the file does not exist so
 * the caller can distinguish "missing → generate new" from other errors.
 */
async function loadToken(tokenPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(tokenPath, 'utf8');
    const token = raw.trim();
    if (token.length === 0) return null;
    return token;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Ensure a token file exists at `tokenPath` with 0600 perms and return its
 * contents. If the file is missing, generates a fresh 32-byte hex token.
 * If the file exists with laxer permissions, tightens them to 0600 and
 * warns on stderr — prevents a world-readable token from silently
 * persisting across restarts.
 */
export async function ensureHttpToken(tokenPath: string = resolveTokenPath()): Promise<{
  token: string;
  path: string;
  freshlyGenerated: boolean;
}> {
  const existing = await loadToken(tokenPath);
  if (existing) {
    // Tighten permissions if the on-disk file has drifted from 0600.
    try {
      const stat = await fs.stat(tokenPath);
      const mode = stat.mode & 0o777;
      if (mode !== TOKEN_FILE_MODE) {
        await fs.chmod(tokenPath, TOKEN_FILE_MODE);
        console.error(`[MCP auth] Tightened permissions on ${tokenPath} from ${mode.toString(8)} to 600.`);
      }
    } catch {
      // Stat / chmod failures are non-fatal; fall through with the token.
    }
    return { token: existing, path: tokenPath, freshlyGenerated: false };
  }

  const dir = path.dirname(tokenPath);
  await fs.mkdir(dir, { recursive: true, mode: TOKEN_DIR_MODE });

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  // `writeFile` with `mode` only sets mode on create; explicit `chmod`
  // after write guards against `fs.open('w')` truncating a file that
  // appeared after our earlier `loadToken` returned null (narrow race,
  // but cheap to defend). The pre-existing-laxer-perms case is handled
  // separately on the `loadToken` success branch above.
  const handle = await fs.open(tokenPath, 'w', TOKEN_FILE_MODE);
  try {
    await handle.writeFile(token + '\n', 'utf8');
    await handle.chmod(TOKEN_FILE_MODE);
  } finally {
    await handle.close();
  }
  return { token, path: tokenPath, freshlyGenerated: true };
}

/**
 * Constant-time compare of an `Authorization: Bearer <token>` header against
 * the expected token. Returns true iff the header is present, well-formed,
 * and matches.
 *
 * Per RFC 7235 the `Bearer` scheme name is case-insensitive (rejecting a
 * spec-compliant client with lowercase `bearer` would be a silent foot-gun),
 * so the scheme prefix check normalizes case. The token value itself is
 * still compared byte-for-byte in constant time.
 *
 * Defensive guard: an empty `expected` token always fails even though
 * `crypto.timingSafeEqual('', '')` would return true. This keeps us safe
 * against a future caller that accidentally passes an empty token.
 */
export function validateBearerToken(authHeader: string | undefined, expected: string): boolean {
  if (typeof authHeader !== 'string') return false;
  if (expected.length === 0) return false;
  const prefix = 'bearer ';
  if (authHeader.slice(0, prefix.length).toLowerCase() !== prefix) return false;
  const candidate = authHeader.slice(prefix.length).trim();
  if (candidate.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Validate the `Host` header against the loopback allow-list for the given
 * port. Blocks DNS-rebinding from a browser that has the server's IP via an
 * attacker-controlled hostname.
 */
export function isValidHost(hostHeader: string | undefined, port: number): boolean {
  if (typeof hostHeader !== 'string') return false;
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}
