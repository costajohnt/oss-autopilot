/**
 * The machine id file (#1856): created once under a fresh temp HOME, read
 * back afterwards, and absent (not fatal) when the file is unusable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMachineId } from './machine-id.js';
import { getMachineIdPath } from './paths.js';
import { enableDebug } from './logger.js';

// Real fs throughout; only `existsSync`, `readFileSync` and `linkSync` are
// spies so single tests can stage a race or a failed create.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
    linkSync: vi.fn(actual.linkSync),
  };
});

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockLinkSync = vi.mocked(fs.linkSync);
const {
  existsSync: realExistsSync,
  readFileSync: realReadFileSync,
  writeFileSync: realWriteFileSync,
} = await vi.importActual<typeof fs>('node:fs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Each test gets its own HOME so a broken id file in one cannot leak into the next. */
const scratch = { home: '', previousHome: '' };

beforeEach(() => {
  scratch.previousHome = process.env.HOME ?? '';
  scratch.home = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-machine-id-'));
  process.env.HOME = scratch.home;
});

afterEach(() => {
  process.env.HOME = scratch.previousHome;
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockLinkSync.mockReset();
  vi.restoreAllMocks();
  fs.rmSync(scratch.home, { recursive: true, force: true });
});

/** Names in the data dir other than the id file itself: a leftover tmp file shows up here. */
function strayDataDirEntries(): string[] {
  return fs.readdirSync(path.dirname(getMachineIdPath())).filter((name) => name !== 'machine-id');
}

function debugLines(errorSpy: { mock: { calls: unknown[][] } }): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]));
}

describe('getMachineId', () => {
  it('writes a random UUID to ~/.oss-autopilot/machine-id on first need and returns it afterwards', () => {
    const idPath = path.join(scratch.home, '.oss-autopilot', 'machine-id');
    expect(fs.existsSync(idPath)).toBe(false);

    const first = getMachineId();
    expect(first).toMatch(UUID);
    expect(getMachineIdPath()).toBe(idPath);
    expect(fs.readFileSync(idPath, 'utf8')).toBe(`${first}\n`);
    expect(strayDataDirEntries()).toEqual([]);

    expect(getMachineId()).toBe(first);
  });

  it.runIf(process.platform !== 'win32')('keeps the file private to the user (mode 0600)', () => {
    getMachineId();
    expect(fs.statSync(getMachineIdPath()).mode & 0o777).toBe(0o600);
  });

  it('reads whatever the file holds, trimmed', () => {
    fs.writeFileSync(getMachineIdPath(), '  stored-id \n');
    expect(getMachineId()).toBe('stored-id');
  });

  it('replaces an empty file left behind by a crash and returns the id now on disk', () => {
    const idPath = getMachineIdPath();
    fs.writeFileSync(idPath, '\n');
    enableDebug();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const fresh = getMachineId();
    expect(fresh).toMatch(UUID);
    expect(fs.readFileSync(idPath, 'utf8')).toBe(`${fresh}\n`);
    expect(strayDataDirEntries()).toEqual([]);
    expect(debugLines(errorSpy).some((line) => line.includes('Replaced empty machine id file'))).toBe(true);
  });

  it('keeps the id another process wrote between the existence check and the create', () => {
    // The check sees no id file; by the time this process creates, another one has.
    // Only that first check on the id file is staged; the data dir check and the re-read stay real.
    const idPath = getMachineIdPath();
    fs.writeFileSync(idPath, 'other-session-id\n');
    const race = { pending: true };
    mockExistsSync.mockImplementation((target) => {
      if (race.pending && String(target) === idPath) {
        race.pending = false;
        return false;
      }
      return realExistsSync(target);
    });
    enableDebug();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(getMachineId()).toBe('other-session-id');
    expect(fs.readFileSync(idPath, 'utf8')).toBe('other-session-id\n');
    expect(strayDataDirEntries()).toEqual([]);
    expect(debugLines(errorSpy).some((line) => line.includes('created by another process'))).toBe(true);
  });

  it('waits for a concurrent creator whose file is still empty and returns the id it then wrote', () => {
    // The other process has created the file but not yet written its id (an older
    // build, or a crash-leftover it is replacing): the first read after EEXIST
    // sees an empty file, the retried read sees the id. Nothing this process
    // wrote may win.
    const idPath = getMachineIdPath();
    fs.writeFileSync(idPath, '');
    const reads = { ofIdFile: 0 };
    mockReadFileSync.mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === idPath) {
        reads.ofIdFile += 1;
        // Read 1 is the initial check, read 2 the first after EEXIST; the other
        // process finishes before the retry.
        if (reads.ofIdFile === 3) realWriteFileSync(idPath, 'other-session-id\n');
      }
      return realReadFileSync(...args);
    });
    enableDebug();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(getMachineId()).toBe('other-session-id');
    expect(realReadFileSync(idPath, 'utf8')).toBe('other-session-id\n');
    expect(reads.ofIdFile).toBe(3);
    expect(strayDataDirEntries()).toEqual([]);
    expect(debugLines(errorSpy).some((line) => line.includes('created by another process'))).toBe(true);
  });

  it('removes its tmp file when the create fails for a reason other than an existing file', () => {
    const idPath = getMachineIdPath();
    mockLinkSync.mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    enableDebug();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(getMachineId()).toBeUndefined();
    expect(fs.existsSync(idPath)).toBe(false);
    expect(strayDataDirEntries()).toEqual([]);
  });

  it('returns no id, with a debug line, when the file can neither be read nor written', () => {
    // A directory in the file's place fails both the read and the write.
    fs.mkdirSync(getMachineIdPath());
    enableDebug();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(getMachineId()).toBeUndefined();
    const logged = debugLines(errorSpy);
    expect(logged.some((line) => line.includes('[DEBUG] [machine-id]') && line.includes('no machineId'))).toBe(true);
  });
});
