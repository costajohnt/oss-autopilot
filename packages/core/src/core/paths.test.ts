import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getCLIVersion, getDataDir } from './paths.js';

// getCLIVersion locates package.json from process.argv[1]. Installed from npm
// that argv entry is the node_modules/.bin symlink, not the bundle (#1664).
describe('getCLIVersion', () => {
  let tmp: string;
  const savedArgv1 = process.argv[1];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-autopilot-version-'));
    fs.mkdirSync(path.join(tmp, 'pkg', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.writeFileSync(path.join(tmp, 'pkg', 'package.json'), JSON.stringify({ version: '9.9.9' }));
    fs.writeFileSync(path.join(tmp, 'pkg', 'dist', 'cli.bundle.cjs'), '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.argv[1] = savedArgv1;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the version when argv[1] is the bundle itself', () => {
    process.argv[1] = path.join(tmp, 'pkg', 'dist', 'cli.bundle.cjs');
    expect(getCLIVersion()).toBe('9.9.9');
  });

  it('reads the version when argv[1] is a .bin-style symlink to the bundle', () => {
    const link = path.join(tmp, 'bin', 'oss-autopilot');
    fs.symlinkSync(path.join('..', 'pkg', 'dist', 'cli.bundle.cjs'), link);
    process.argv[1] = link;
    expect(getCLIVersion()).toBe('9.9.9');
  });

  it('falls back to 0.0.0 when no package.json sits beside the entry', () => {
    process.argv[1] = path.join(tmp, 'bin', 'missing.cjs');
    expect(getCLIVersion()).toBe('0.0.0');
  });

  it('prefers the bundle-injected core version over the package.json beside argv[1] (#1732)', () => {
    // Inside the MCP server bundle, argv[1] points at the mcp-server package.
    process.argv[1] = path.join(tmp, 'pkg', 'dist', 'cli.bundle.cjs');
    vi.stubGlobal('__OSS_AUTOPILOT_CORE_VERSION__', '3.1.4');
    expect(getCLIVersion()).toBe('3.1.4');
  });
});

// A test run once rewrote the real ~/.oss-autopilot/state-cache.json (#1801).
describe('test isolation from the real data dir (#1801)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs every test file under a temp HOME, not the real one', () => {
    expect(os.homedir()).not.toBe(os.userInfo().homedir);
    expect(fs.realpathSync(os.homedir()).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
  });

  it('runs with no GitHub token in the environment', () => {
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it('getDataDir refuses the real home directory under vitest', () => {
    vi.stubEnv('HOME', os.userInfo().homedir);
    vi.stubEnv('USERPROFILE', os.userInfo().homedir);
    expect(() => getDataDir()).toThrow(/real home directory/);
  });
});
