/**
 * The overnight handoff: how a tick that holds no write-capable GitHub
 * credential gets its prepared branches to `overnight push-prep`, which does.
 *
 * On a box where the model tick runs as its own unix user, that user must not
 * share a git directory with the user holding the token: `push-prep` running
 * git in a repo the tick can write would run the tick's hooks, `core.fsmonitor`,
 * `core.sshCommand`, credential helpers and `insteadOf` rewrites as the
 * token holder. So the handoff is data only. With `OSS_AUTOPILOT_HANDOFF_DIR`
 * set, `overnight` / `record` / `implement-blocked` (the tick) write into that
 * directory:
 *
 * - `<branch>.bundle`: `git bundle` of each prepared branch;
 * - `last-overnight.json`: the run's state record, without local paths;
 * - `report.md`: the morning report.
 *
 * `push-prep` (the token holder, same env var) reads those files as untrusted
 * input: never through a symlink, a FIFO or a hard link, size-capped, schema-
 * checked, and each bundle is fetched into a fresh private repo it pushes from.
 * Unset (the single-user default), nothing here runs.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OvernightRecordSchema } from '../core/state-schema.js';
import type { OvernightRecord } from '../core/types.js';

export const HANDOFF_ENV = 'OSS_AUTOPILOT_HANDOFF_DIR';
export const HANDOFF_STATE = 'last-overnight.json';
export const HANDOFF_REPORT = 'report.md';

const MAX_STATE_BYTES = 1 << 20;
const MAX_REPORT_BYTES = 1 << 20;
// GitHub rejects pushes over 2 GiB anyway.
const MAX_BUNDLE_BYTES = 2 * 1024 ** 3;
const MAX_PREPARED = 50;
const MAX_NOTE_CHARS = 500;
const GIT_TIMEOUT_MS = 10 * 60_000;

/** The drop dir, or null when this box does not split the tick from the pusher. */
export function handoffDir(): string | null {
  return process.env[HANDOFF_ENV] || null;
}

/** Pure: a flat file name for a branch's bundle; never a path. */
export function bundleFileFor(branch: string): string {
  const stem = branch.replaceAll(/[^\w.-]/g, '_').replace(/^\.+/, '_');
  const hash = createHash('sha1').update(branch).digest('hex').slice(0, 8);
  return `${stem}_${hash}.bundle`;
}

function gitRun(args: string[]): void {
  execFileSync('git', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** Group-readable (the pusher reads it through the drop dir's group), whatever the umask. */
function publishFile(dir: string, name: string, write: (tmp: string) => void): void {
  const tmp = path.join(dir, `.${name}.tmp`);
  fs.rmSync(tmp, { force: true });
  write(tmp);
  fs.chmodSync(tmp, 0o640);
  fs.renameSync(tmp, path.join(dir, name));
}

// ── Tick side ─────────────────────────────────────────────────────────

/**
 * Bundle `branch` from `worktree` into the drop dir.
 * ponytail: full-history bundle, so the pusher needs no clone of its own; it
 * costs the repo's size per prepared branch. Thin bundles against a pusher-
 * side mirror if a big repo ever makes that hurt.
 */
export function writeHandoffBundle(dir: string, worktree: string, branch: string): void {
  publishFile(dir, bundleFileFor(branch), (tmp) =>
    gitRun(['-C', worktree, 'bundle', 'create', '-q', tmp, `refs/heads/${branch}`]),
  );
}

/** Write the run's state record (local paths dropped) and its report into the drop dir. */
export function exportHandoff(dir: string, record: OvernightRecord): void {
  const prepared = record.prepared.map(({ worktree: _local, ...rest }) => rest);
  publishFile(dir, HANDOFF_STATE, (tmp) => fs.writeFileSync(tmp, JSON.stringify({ ...record, prepared })));
  if (fs.existsSync(record.reportPath)) {
    publishFile(dir, HANDOFF_REPORT, (tmp) => fs.copyFileSync(record.reportPath, tmp));
  }
}

/** Drop bundles of branches the current run no longer lists. */
export function pruneHandoffBundles(dir: string, keepBranches: string[]): void {
  const keep = new Set(keepBranches.map((b) => bundleFileFor(b)));
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.bundle') && !keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

// ── Pusher side: everything below reads files the tick wrote ─────────

/**
 * Stream a drop-dir file the tick wrote to `onChunk`. No symlinks
 * (O_NOFOLLOW), no FIFO that would block the open (O_NONBLOCK), regular files
 * only, no hard link to a file the tick could not read itself, a size cap, and
 * exactly the size checked is read: the tick owns the file and could keep
 * appending to it while it is read.
 */
function streamUntrusted(file: string, maxBytes: number, onChunk: (chunk: Buffer) => void): void {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (st.nlink !== 1) throw new Error(`${file} has ${st.nlink} links; refusing a hard-linked file`);
    if (st.size > maxBytes) throw new Error(`${file} is ${st.size} bytes, over the ${maxBytes} byte cap`);
    const buf = Buffer.alloc(Math.max(1, Math.min(st.size, 1 << 20)));
    let left = st.size;
    while (left > 0) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), null);
      if (n === 0) throw new Error(`${file} shrank while being read`);
      onChunk(buf.subarray(0, n));
      left -= n;
    }
    if (fs.readSync(fd, buf, 0, 1, null) > 0) throw new Error(`${file} grew while being read`);
  } finally {
    fs.closeSync(fd);
  }
}

function readUntrusted(file: string, maxBytes: number): string {
  const chunks: Buffer[] = [];
  streamUntrusted(file, maxBytes, (c) => chunks.push(Buffer.from(c)));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The tick's state record, validated. Only fields the pusher needs survive;
 * local paths and push results from the tick side are dropped, and
 * `reportPath` is left for the caller to set to its own.
 */
export function loadHandoff(dir: string): { record: OvernightRecord; report: string | null } {
  const file = path.join(dir, HANDOFF_STATE);
  let raw: unknown;
  try {
    raw = JSON.parse(readUntrusted(file, MAX_STATE_BYTES));
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT')
      throw new Error(`No overnight handoff at ${file} yet.`, { cause: err });
    throw err;
  }
  const parsed = OvernightRecordSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is not an overnight record: ${parsed.error.message}`);
  const r = parsed.data;
  if (Number.isNaN(Date.parse(r.runAt))) throw new Error(`${file} has an unreadable runAt: ${r.runAt}`);
  if (r.prepared.length > MAX_PREPARED) throw new Error(`${file} lists ${r.prepared.length} branches`);

  let report: string | null = null;
  try {
    report = readUntrusted(path.join(dir, HANDOFF_REPORT), MAX_REPORT_BYTES);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }
  return {
    record: {
      runAt: r.runAt,
      reportPath: '',
      prepareCount: r.prepareCount,
      judgmentCount: r.judgmentCount,
      prepared: r.prepared.map((p) => ({
        url: p.url,
        branch: p.branch,
        recordedAt: p.recordedAt,
        ...(p.note && { note: p.note.slice(0, MAX_NOTE_CHARS) }),
      })),
      ...(r.implementUrl && { implementUrl: r.implementUrl }),
      ...(r.implementAttempts && { implementAttempts: r.implementAttempts }),
    },
    report,
  };
}

/**
 * Fetch `branch` from its bundle into a fresh bare repo under a private temp
 * dir. The bundle is copied through a checked descriptor first, so the tick
 * cannot swap the file between the check and git reading it. The caller
 * pushes from `repo` and must call `cleanup`.
 */
export function importHandoffBundle(dir: string, branch: string): { repo: string; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-push-prep-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const copy = path.join(tmp, 'in.bundle');
    const out = fs.openSync(copy, 'wx', 0o600);
    try {
      streamUntrusted(path.join(dir, bundleFileFor(branch)), MAX_BUNDLE_BYTES, (c) => fs.writeSync(out, c));
    } finally {
      fs.closeSync(out);
    }
    const repo = path.join(tmp, 'repo.git');
    gitRun(['init', '-q', '--bare', repo]);
    gitRun([
      '-C',
      repo,
      '-c',
      'fetch.fsckObjects=true',
      'fetch',
      '-q',
      '--no-tags',
      copy,
      `+refs/heads/${branch}:refs/heads/${branch}`,
    ]);
    return { repo, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
