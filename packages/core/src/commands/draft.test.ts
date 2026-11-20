/**
 * Tests for the draft directory and the approved-file reader (#1930), against
 * real files under the per-test-file temp HOME (test-lib/isolate-home.ts).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { extractFromFence } from '../core/untrusted-content.js';
import { MAX_DRAFT_BYTES, assertSha256, getDraftsDir, readDraft, runDraftPath, runDraftShow } from './draft.js';

const TEXT = 'Use `make lint` before pushing & keep <details> short.\n';
const SHA = createHash('sha256').update(TEXT, 'utf8').digest('hex');
const isPosix = process.platform !== 'win32';
/** What `mkdir -p` leaves under a 022 umask. */
const UMASK_022_DIR_MODE = Number.parseInt('755', 8);

function dataTmp(): string {
  return path.join(os.homedir(), '.oss-autopilot', 'tmp');
}

function writeDraft(name: string, text: string): string {
  const file = runDraftPath({ name }).path;
  fs.writeFileSync(file, text, { mode: 0o644 });
  return file;
}

afterEach(() => {
  fs.rmSync(path.join(os.homedir(), '.oss-autopilot'), { recursive: true, force: true });
});

describe('getDraftsDir', () => {
  it.runIf(isPosix)('creates ~/.oss-autopilot/tmp with mode 0700', () => {
    const dir = getDraftsDir();
    expect(dir).toBe(fs.realpathSync(dataTmp()));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.runIf(isPosix)('tightens an existing directory that others could enter', () => {
    fs.mkdirSync(dataTmp(), { recursive: true });
    fs.chmodSync(dataTmp(), UMASK_022_DIR_MODE);
    expect(fs.statSync(getDraftsDir()).mode & 0o777).toBe(0o700);
  });

  it.runIf(isPosix)('refuses a draft directory that is a symlink', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-elsewhere-'));
    fs.mkdirSync(path.dirname(dataTmp()), { recursive: true });
    fs.symlinkSync(elsewhere, dataTmp());
    expect(() => getDraftsDir()).toThrow(/not a directory owned by the current user/);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('runDraftPath', () => {
  it('returns a path directly inside the draft directory without creating the file', () => {
    const out = runDraftPath({ name: 'owner--repo-42-comment.md' });
    expect(out.dir).toBe(getDraftsDir());
    expect(out.path).toBe(path.join(out.dir, 'owner--repo-42-comment.md'));
    expect(fs.existsSync(out.path)).toBe(false);
  });

  it.each(['', '../escape.md', 'a/b.md', String.raw`a\b.md`, '.hidden', '-rf', 'sp ace.md', 'x'.repeat(201)])(
    'rejects the name %j',
    (name) => {
      expect(() => runDraftPath({ name })).toThrow(/Invalid draft name/);
    },
  );
});

describe('readDraft', () => {
  it('returns the text and the hash of that text from one read', () => {
    const file = writeDraft('reply.md', TEXT);
    expect(readDraft(file)).toEqual({ path: file, content: TEXT, sha256: SHA, byteSize: Buffer.byteLength(TEXT) });
  });

  it('resolves a bare name against the draft directory, not the cwd', () => {
    const file = writeDraft('reply.md', TEXT);
    expect(readDraft('reply.md').path).toBe(file);
  });

  it('refuses a file outside the draft directory', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-outside-'));
    const outside = path.join(outsideDir, 'reply.md');
    fs.writeFileSync(outside, TEXT);
    expect(() => readDraft(outside)).toThrow(/drafts must be files directly inside/);
    expect(() => readDraft('../state.json')).toThrow(/drafts must be files directly inside/);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('refuses a file in a subdirectory or a missing directory', () => {
    const sub = path.join(getDraftsDir(), 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'reply.md'), TEXT);
    expect(() => readDraft(path.join(sub, 'reply.md'))).toThrow(/drafts must be files directly inside/);
    expect(() => readDraft('missing-dir/reply.md')).toThrow(/drafts must be files directly inside/);
  });

  it('fails on a missing file and on a directory', () => {
    expect(() => readDraft('absent.md')).toThrow(/ENOENT/);
    fs.mkdirSync(path.join(getDraftsDir(), 'adir'));
    expect(() => readDraft('adir')).toThrow(/not a regular file/);
  });

  it.runIf(isPosix)('refuses a symlink, even to a file the user owns', () => {
    const real = writeDraft('real.md', TEXT);
    const link = path.join(getDraftsDir(), 'link.md');
    fs.symlinkSync(real, link);
    expect(() => readDraft(link)).toThrow(/not a regular file/);
  });

  it.runIf(isPosix).each([0o664, 0o646, 0o666])('refuses a group- or world-writable file (mode %o)', (mode) => {
    const file = writeDraft('loose.md', TEXT);
    fs.chmodSync(file, mode);
    expect(() => readDraft(file)).toThrow(/not group- or world-writable/);
  });

  it('enforces the size cap', () => {
    const atCap = writeDraft('at-cap.md', 'a'.repeat(MAX_DRAFT_BYTES));
    expect(readDraft(atCap).byteSize).toBe(MAX_DRAFT_BYTES);
    const over = writeDraft('over.md', 'a'.repeat(MAX_DRAFT_BYTES + 1));
    expect(() => readDraft(over)).toThrow(/larger than 65536 bytes/);
  });
});

describe('runDraftShow', () => {
  it('returns content and a matching hash, unfenced by default', () => {
    const file = writeDraft('reply.md', TEXT);
    const out = runDraftShow({ file, untrusted: false });
    expect(out).toEqual({ path: file, content: TEXT, sha256: SHA, byteSize: Buffer.byteLength(TEXT), fenced: false });
    expect(() => assertSha256(out.content, out.sha256)).not.toThrow();
  });

  it('fences untrusted text and still hashes the unwrapped text', () => {
    const file = writeDraft('guidelines-owner--repo.md', TEXT);
    const out = runDraftShow({ file, untrusted: true });
    expect(out.fenced).toBe(true);
    expect(out.content).toMatch(/^<github-content label="guidelines-owner--repo.md" source="draft">/);
    expect(out.content).not.toContain('<details>');
    expect(extractFromFence(out.content)).toBe(TEXT);
    expect(out.sha256).toBe(SHA);
  });
});

describe('assertSha256', () => {
  it('passes without an expected hash, and on a match in either case', () => {
    expect(() => assertSha256(TEXT, undefined)).not.toThrow();
    expect(() => assertSha256(TEXT, SHA)).not.toThrow();
    expect(() => assertSha256(TEXT, SHA.toUpperCase())).not.toThrow();
  });

  it('throws on a mismatch and on a malformed hash', () => {
    expect(() => assertSha256(`${TEXT}x`, SHA)).toThrow(/does not match the approved text/);
    expect(() => assertSha256(TEXT, 'abc123')).toThrow(/must be 64 hex characters/);
    expect(() => assertSha256(TEXT, '')).toThrow(/must be 64 hex characters/);
  });
});
