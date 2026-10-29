/**
 * Vitest setup file: every test file runs under a fresh temp HOME with no
 * GitHub token, so no test can read or rewrite the real ~/.oss-autopilot or
 * reach the user's real Gist (#1801). The nightly live-API run keeps its token.
 */
import { afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-autopilot-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.GH_CONFIG_DIR;
delete process.env.XDG_CONFIG_HOME;
if (process.env.OSS_AUTOPILOT_NIGHTLY !== '1') {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
}

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
