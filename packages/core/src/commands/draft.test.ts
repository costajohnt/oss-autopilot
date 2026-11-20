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
import {
  MAX_DRAFT_AGE_MS,
  MAX_DRAFT_BYTES,
  assertSha256,
  getDraftsDir,
  readApprovedDraft,
  readDraft,
  runDraftPath,
  runDraftShow,
} from './draft.js';

const TEXT = 'Use `make lint` before pushing & keep <details> short.\n';
const SHA = createHash('sha256').update(TEXT, 'utf8').digest('hex');
const isPosix = process.platform !== 'win32';
/** What `mkdir -p` leaves under a 022 umask. */
const UMASK_022_DIR_MODE = Number.parseInt('755', 8);
const GROUP_WRITABLE = Number.parseInt('664', 8);
const WORLD_WRITABLE = Number.parseInt('646', 8);
const WORLD_AND_GROUP_WRITABLE = Number.parseInt('666', 8);

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
    expect(() => getDraftsDir()).toThrow(/not a symlink or a file\. Remove or rename .*tmp and rerun/);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it.runIf(isPosix)('refuses a dangling symlink or a file in the way, and says what to do', () => {
    fs.mkdirSync(path.dirname(dataTmp()), { recursive: true });
    fs.symlinkSync(path.join(os.tmpdir(), 'draft-no-such-target'), dataTmp());
    expect(() => getDraftsDir()).toThrow(/Remove or rename .*tmp and rerun/);
    fs.unlinkSync(dataTmp());
    fs.writeFileSync(dataTmp(), 'in the way');
    expect(() => getDraftsDir()).toThrow(/Remove or rename .*tmp and rerun/);
  });

  it('removes drafts older than 30 days and keeps recent ones and non-files', () => {
    const old = writeDraft('old.md', TEXT);
    const recent = writeDraft('recent.md', TEXT);
    const subdir = path.join(getDraftsDir(), 'old-dir');
    fs.mkdirSync(subdir);
    const longAgo = new Date(Date.now() - MAX_DRAFT_AGE_MS - 60_000);
    fs.utimesSync(old, longAgo, longAgo);
    fs.utimesSync(subdir, longAgo, longAgo);

    getDraftsDir();

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(subdir)).toBe(true);
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
    expect(() => readDraft('absent.md')).toThrow(/No draft at .*absent\.md: write it first \(see `draft path`\)/);
    fs.mkdirSync(path.join(getDraftsDir(), 'adir'));
    expect(() => readDraft('adir')).toThrow(/not a regular file/);
  });

  it.runIf(isPosix)('refuses a symlink, even to a file the user owns', () => {
    const real = writeDraft('real.md', TEXT);
    const link = path.join(getDraftsDir(), 'link.md');
    fs.symlinkSync(real, link);
    expect(() => readDraft(link)).toThrow(/not a regular file/);
  });

  it.runIf(isPosix).each([WORLD_WRITABLE, WORLD_AND_GROUP_WRITABLE])(
    'refuses a world-writable file (mode %o)',
    (mode) => {
      const file = writeDraft('loose.md', TEXT);
      fs.chmodSync(file, mode);
      expect(() => readDraft(file)).toThrow(/not world-writable/);
    },
  );

  it.runIf(isPosix)('accepts a group-writable file, as a 002 umask writes it', () => {
    const file = writeDraft('group.md', TEXT);
    fs.chmodSync(file, GROUP_WRITABLE);
    expect(readDraft(file).content).toBe(TEXT);
  });

  it.runIf(isPosix)('refuses a file with a second hard link', () => {
    const file = writeDraft('linked.md', TEXT);
    fs.linkSync(file, path.join(getDraftsDir(), 'linked-again.md'));
    expect(() => readDraft(file)).toThrow(/no other hard link/);
  });

  it('refuses invalid UTF-8 and a byte order mark', () => {
    const invalid = runDraftPath({ name: 'invalid.md' }).path;
    fs.writeFileSync(invalid, Buffer.from([0x68, 0x69, 0xff, 0xfe]));
    expect(() => readDraft(invalid)).toThrow(/not valid UTF-8/);
    const bom = runDraftPath({ name: 'bom.md' }).path;
    fs.writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT)]));
    expect(() => readDraft(bom)).toThrow(/byte order mark/);
  });

  it('enforces the size cap', () => {
    const atCap = writeDraft('at-cap.md', 'a'.repeat(MAX_DRAFT_BYTES));
    expect(readDraft(atCap).byteSize).toBe(MAX_DRAFT_BYTES);
    const over = writeDraft('over.md', 'a'.repeat(MAX_DRAFT_BYTES + 1));
    expect(() => readDraft(over)).toThrow(/larger than 65536 bytes/);
  });
});

describe('readApprovedDraft', () => {
  it('returns the file text when it is the only source and a hash is given', () => {
    const file = writeDraft('reply.md', TEXT);
    const request = { file, flag: '--body-file', expectSha256: SHA, hasOtherInput: false } as const;
    expect(readApprovedDraft(request)).toBe(TEXT);
  });

  it('refuses a second source of the text instead of picking one', () => {
    const file = writeDraft('reply.md', TEXT);
    const request = { file, flag: '--from-file', expectSha256: SHA, hasOtherInput: true } as const;
    expect(() => readApprovedDraft(request)).toThrow(/--from-file cannot be combined with another source/);
  });

  it('requires --expect-sha256 and points at draft show', () => {
    const file = writeDraft('reply.md', TEXT);
    const request = { file, flag: '--body-file', expectSha256: undefined, hasOtherInput: false } as const;
    expect(() => readApprovedDraft(request)).toThrow(/--body-file requires --expect-sha256: run `draft show`/);
  });

  it.each(['', ' \n\t\n'])('refuses an empty or whitespace-only file (%j)', (text) => {
    const file = writeDraft('empty.md', text);
    const request = { file, flag: '--body-file', expectSha256: SHA, hasOtherInput: false } as const;
    expect(() => readApprovedDraft(request)).toThrow('draft file is empty');
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
