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
/** Drafts the user never posted or discarded are removed after this long. */
export const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

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

/** Create the directory if needed and stat it without following a symlink. Null when something is in the way. */
function makeAndStatDir(dir: string): fs.Stats | null {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return fs.lstatSync(dir);
  } catch {
    return null;
  }
}

function removeStaleDrafts(dir: string): void {
  const cutoff = Date.now() - MAX_DRAFT_AGE_MS;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isFile() && !isOwnedBySomeoneElse(stat) && stat.mtimeMs < cutoff) fs.unlinkSync(file);
  }
}

/**
 * The draft directory, `~/.oss-autopilot/tmp`, created owner-only. An existing
 * directory with looser permissions (made by `mkdir -p` under a 022 umask) is
 * tightened; a symlink, a file in the way, or a directory owned by someone
 * else is refused. Returns the real path so callers can compare against it.
 *
 * Also unlinks the user's own regular files in it older than
 * {@link MAX_DRAFT_AGE_MS}, so abandoned drafts do not pile up. Best effort.
 */
export function getDraftsDir(): string {
  const dir = path.join(getDataDir(), 'tmp');
  const stat = makeAndStatDir(dir);
  if (!stat?.isDirectory() || isOwnedBySomeoneElse(stat)) {
    throw new ValidationError(
      `Draft directory ${dir} must be a real directory owned by the current user, not a symlink or a file. ` +
        `Remove or rename ${dir} and rerun.`,
    );
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  const real = fs.realpathSync(dir);
  try {
    removeStaleDrafts(real);
  } catch {
    // Cleanup only: a file that vanished or cannot be removed must not fail the command.
  }
  return real;
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

/** Read at most the cap plus one byte, so an oversized or growing file is never read to its end. */
function readCapped(fd: number): Buffer {
  const buffer = Buffer.alloc(MAX_DRAFT_BYTES + 1);
  let length = 0;
  let read = -1;
  while (read !== 0 && length < buffer.length) {
    read = fs.readSync(fd, buffer, length, buffer.length - length, null);
    length += read;
  }
  return buffer.subarray(0, length);
}

function decodeUtf8(bytes: Buffer, target: string): string {
  if (bytes.subarray(0, 3).equals(UTF8_BOM)) {
    throw new ValidationError(`Refusing to read ${target}: it starts with a byte order mark; save it as plain UTF-8`);
  }
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    throw new ValidationError(`Refusing to read ${target}: it is not valid UTF-8`);
  }
}

/** Check the opened file (not the path, which could have been swapped since) and read it once. */
function readOpenDraft(fd: number, target: string): DraftContent {
  const stat = fs.fstatSync(fd);
  // Group-writable is allowed: a 002 umask writes 0664, and the directory is
  // owner-only, so group members cannot reach the file through this path.
  if (!stat.isFile() || isOwnedBySomeoneElse(stat) || (stat.mode & 0o002) !== 0 || stat.nlink !== 1) {
    throw new ValidationError(
      `Refusing to read ${target}: it must be a regular file owned by the current user, not world-writable, with no other hard link`,
    );
  }
  const bytes = readCapped(fd);
  if (bytes.length > MAX_DRAFT_BYTES) {
    throw new ValidationError(`Refusing to read ${target}: larger than ${MAX_DRAFT_BYTES} bytes`);
  }
  const content = decodeUtf8(bytes, target);
  return { content, path: target, sha256: sha256Hex(content), byteSize: bytes.length };
}

/**
 * Read a draft once and return its text with the hash of that text.
 *
 * Refuses a file that is not directly inside the draft directory, a symlink
 * or other non-regular file, a file owned by another user, a world-writable
 * or hard-linked file, invalid UTF-8, a byte order mark, and anything over
 * {@link MAX_DRAFT_BYTES}. A bare name or relative path resolves against the
 * draft directory, never the cwd.
 */
export function readDraft(file: string): DraftContent {
  const dir = getDraftsDir();
  const requested = path.resolve(dir, file);
  if (realDirOf(requested) !== dir) {
    throw new ValidationError(`Refusing to read ${requested}: drafts must be files directly inside ${dir}`);
  }
  const target = path.join(dir, path.basename(requested));
  const found = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!found) {
    throw new ValidationError(`No draft at ${target}: write it first (see \`draft path\`)`);
  }
  if (!found.isFile()) {
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

/** What a command was given alongside `--body-file` / `--from-file`. */
export interface ApprovedDraftRequest {
  file: string;
  flag: '--body-file' | '--from-file';
  expectSha256: string | undefined;
  /** The text was also supplied another way (`--stdin`, positional words, `--content`). */
  hasOtherInput: boolean;
}

/**
 * The text of a draft a command is about to post or store. The file is the
 * only source (no silent winner among several), the caller must say which
 * text the user approved, and an empty file never falls back to a default.
 * The hash itself is checked by the command, next to its other gates.
 */
export function readApprovedDraft(request: ApprovedDraftRequest): string {
  const { flag } = request;
  if (request.hasOtherInput) {
    throw new ValidationError(
      `${flag} cannot be combined with another source of the text (--stdin, positional words or --content)`,
    );
  }
  if (request.expectSha256 === undefined) {
    throw new ValidationError(
      `${flag} requires --expect-sha256: run \`draft show\` on the file, show the user its content, ` +
        'and pass the sha256 it returned',
    );
  }
  const { content } = readDraft(request.file);
  if (content.trim() === '') throw new ValidationError('draft file is empty');
  return content;
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
