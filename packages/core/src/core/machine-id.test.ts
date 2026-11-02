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

// Real fs throughout; only `existsSync` is a spy so one test can stage the
// "file appeared between the check and the write" race.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const mockExistsSync = vi.mocked(fs.existsSync);
const { existsSync: realExistsSync } = await vi.importActual<typeof fs>('node:fs');

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
  vi.restoreAllMocks();
  fs.rmSync(scratch.home, { recursive: true, force: true });
});

describe('getMachineId', () => {
  it('writes a random UUID to ~/.oss-autopilot/machine-id on first need and returns it afterwards', () => {
    const idPath = path.join(scratch.home, '.oss-autopilot', 'machine-id');
    expect(fs.existsSync(idPath)).toBe(false);

    const first = getMachineId();
    expect(first).toMatch(UUID);
    expect(getMachineIdPath()).toBe(idPath);
    expect(fs.readFileSync(idPath, 'utf8')).toBe(`${first}\n`);

    expect(getMachineId()).toBe(first);
  });

  it.runIf(process.platform !== 'win32')('keeps the file private to the user (mode 0600)', () => {
    getMachineId();
    expect(fs.statSync(getMachineIdPath()).mode & 0o777).toBe(0o600);
  });

  it('reads whatever the file holds, trimmed, and replaces an empty file with a fresh id', () => {
    const idPath = getMachineIdPath();
    fs.writeFileSync(idPath, '  stored-id \n');
    expect(getMachineId()).toBe('stored-id');

    fs.writeFileSync(idPath, '\n');
    const fresh = getMachineId();
    expect(fresh).toMatch(UUID);
    expect(fs.readFileSync(idPath, 'utf8')).toBe(`${fresh}\n`);
  });

  it('keeps the id another process wrote between the existence check and the create', () => {
    // The check sees no id file; by the time this process writes, another one has created it.
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
    const logged = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('created by another process'))).toBe(true);
  });

  it('returns no id, with a debug line, when the file can neither be read nor written', () => {
    // A directory in the file's place fails both the read and the write.
    fs.mkdirSync(getMachineIdPath());
    enableDebug();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(getMachineId()).toBeUndefined();
    const logged = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('[DEBUG] [machine-id]') && line.includes('no machineId'))).toBe(true);
  });
});
