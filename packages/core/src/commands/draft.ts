/**
 * Draft files (#1930): text an agent stages for the user to approve before a
 * command posts or stores it.
 *
 * Drafts used to be staged at predictable paths under `/tmp`, where another
 * local user can pre-create or symlink the path, and the content could change
 * between the user approving it and a command reading it. They now live in
 * `~/.oss-autopilot/tmp` (owner-only), a command reads the file itself
 * (`--body-file`, `--from-file`) instead of taking the text as a shell
 * argument, and `--expect-sha256` pins the read to the text the user saw.
 *
 * `draft path` and `draft show` only touch that directory: no GitHub access,
 * no state, so they are safe in an unattended run.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../core/paths.js';
import { ValidationError } from '../core/errors.js';
import { wrapUntrustedContent } from '../core/untrusted-content.js';

/** Largest draft a command reads. GitHub caps a comment body at 65536 characters; each command's own cap still applies. */
export const MAX_DRAFT_BYTES = 64 * 1024;

/** A bare file name: no separators, no leading dot or dash. */
const SAFE_NAME = /^\w[\w.-]{0,199}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export interface DraftPathOutput {
  /** Absolute path for the draft. The file is not created. */
  path: string;
  /** The owner-only draft directory. */
  dir: string;
}

export interface DraftContent {
  path: string;
  /** The file's text, from the same single read that produced `sha256`. */
  content: string;
  /** SHA-256 (hex) of the file's text as UTF-8. Pass it back as `--expect-sha256`. */
  sha256: string;
  byteSize: number;
}

export interface DraftShowOutput extends DraftContent {
  /** True when `content` is wrapped in the untrusted-content fence (`--untrusted`). `sha256` is always of the unwrapped text. */
  fenced: boolean;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Throw unless `content` hashes to `expected`. A no-op when `expected` is
 * undefined. Callers run it before their first side effect.
 */
export function assertSha256(content: string, expected: string | undefined): void {
  if (expected === undefined) return;
  if (!SHA256_HEX.test(expected)) {
    throw new ValidationError('--expect-sha256 must be 64 hex characters');
  }
  const actual = sha256Hex(content);
  if (actual !== expected.toLowerCase()) {
    throw new ValidationError(
      `Content does not match the approved text (expected sha256 ${expected.toLowerCase()}, got ${actual}). ` +
        'Nothing was posted or stored. Run `draft show` again and show the user the current text.',
    );
  }
}

/** False on platforms without POSIX uids (Windows), where the check cannot be made. */
function isOwnedBySomeoneElse(stat: fs.Stats): boolean {
  const uid = process.getuid?.();
  return uid !== undefined && stat.uid !== uid;
}

/**
 * The draft directory, `~/.oss-autopilot/tmp`, created owner-only. An existing
 * directory with looser permissions (made by `mkdir -p` under a 022 umask) is
 * tightened; a symlink, or a directory owned by someone else, is refused.
 * Returns the real path so callers can compare against it.
 */
export function getDraftsDir(): string {
  const dir = path.join(getDataDir(), 'tmp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || isOwnedBySomeoneElse(stat)) {
    throw new ValidationError(`Draft directory ${dir} is not a directory owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return fs.realpathSync(dir);
}

/** `draft path <name>`: where to write a draft. Deterministic, so a later session can find a waiting proposal. */
export function runDraftPath(options: { name: string }): DraftPathOutput {
  if (!SAFE_NAME.test(options.name)) {
    throw new ValidationError(
      `Invalid draft name "${options.name}": use letters, digits, ".", "_" and "-" only, starting with a letter, digit or "_"`,
    );
  }
  const dir = getDraftsDir();
  return { path: path.join(dir, options.name), dir };
}

function realDirOf(file: string): string | null {
  try {
    return fs.realpathSync(path.dirname(file));
  } catch {
    return null;
  }
}

/** Check the opened file (not the path, which could have been swapped since) and read it once. */
function readOpenDraft(fd: number, target: string): DraftContent {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || isOwnedBySomeoneElse(stat) || (stat.mode & 0o022) !== 0) {
    throw new ValidationError(
      `Refusing to read ${target}: it must be a regular file owned by the current user and not group- or world-writable`,
    );
  }
  const bytes = stat.size > MAX_DRAFT_BYTES ? null : fs.readFileSync(fd);
  if (bytes === null || bytes.length > MAX_DRAFT_BYTES) {
    throw new ValidationError(`Refusing to read ${target}: larger than ${MAX_DRAFT_BYTES} bytes`);
  }
  const content = bytes.toString('utf8');
  return { content, path: target, sha256: sha256Hex(content), byteSize: bytes.length };
}

/**
 * Read a draft once and return its text with the hash of that text.
 *
 * Refuses a file that is not directly inside the draft directory, a symlink
 * or other non-regular file, a file owned by another user, a group- or
 * world-writable file, and anything over {@link MAX_DRAFT_BYTES}. A bare name
 * or relative path resolves against the draft directory, never the cwd.
 */
export function readDraft(file: string): DraftContent {
  const dir = getDraftsDir();
  const requested = path.resolve(dir, file);
  if (realDirOf(requested) !== dir) {
    throw new ValidationError(`Refusing to read ${requested}: drafts must be files directly inside ${dir}`);
  }
  const target = path.join(dir, path.basename(requested));
  if (!fs.lstatSync(target).isFile()) {
    throw new ValidationError(`Refusing to read ${target}: not a regular file (symlinks are not followed)`);
  }
  // O_NOFOLLOW closes the gap between the lstat above and the open; the
  // fstat below checks the file that was actually opened.
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    return readOpenDraft(fd, target);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `draft show <file>`: the text to show the user and the hash to pass back,
 * from one read. With `untrusted`, `content` comes back inside the
 * untrusted-content fence: use it for text distilled from other people's
 * writing (guideline proposals), not for a reply the user dictated.
 */
export function runDraftShow(options: { file: string; untrusted: boolean }): DraftShowOutput {
  const draft = readDraft(options.file);
  if (!options.untrusted) return { ...draft, fenced: false };
  const content = wrapUntrustedContent(draft.content, path.basename(draft.path), { source: 'draft' });
  return { ...draft, content, fenced: true };
}
