#!/usr/bin/env node
/**
 * Keep the plugin's .mcp.json pinned to the released @oss-autopilot/mcp version.
 *
 * .mcp.json launches the MCP server with `npx @oss-autopilot/mcp@<version>`.
 * The pin must equal packages/mcp-server/package.json's version, which
 * release-please bumps on the release PR branch. release-please cannot
 * maintain the pin itself: its json updater replaces the whole string with
 * the bare version ("5.7.6" instead of "@oss-autopilot/mcp@5.7.6"), and JSON
 * cannot carry x-release-please-version markers. So:
 *
 *   node scripts/sync-mcp-pin.mjs            rewrite the pin from package.json
 *   node scripts/sync-mcp-pin.mjs --check    exit 1 if the pin is out of sync
 *
 * The write mode runs in .github/workflows/release-please.yml on the release
 * PR branch; the check mode runs in ci.yml's MCP metadata guard. The rewrite
 * is textual (one quoted string swapped) so the file's formatting survives.
 *
 * An optional positional argument overrides the repo root (used by the test
 * harness, scripts/sync-mcp-pin.test.sh).
 *
 * Why plain `npx <pkg>@<version>` and not `--prefer-offline`: npm's exec
 * always fetches the packument (libnpmexec forces preferOnline), so the pin
 * does not remove the registry lookup at session start. `--prefer-offline`
 * would skip the network, but after a pin bump npm answers ETARGET from the
 * stale cached packument and never refetches, so it breaks every release.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@oss-autopilot/mcp';
const SERVER_KEY = 'oss-autopilot';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`sync-mcp-pin: ${message}`);
  process.exit(1);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${label} (${path}): ${error.message}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const unknown = argv.filter((arg) => arg.startsWith('--') && arg !== '--check');
  if (unknown.length > 0) fail(`unknown option ${unknown.join(' ')}`);

  const rootArg = argv.find((arg) => !arg.startsWith('--'));
  const root = rootArg ? resolve(rootArg) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkgPath = join(root, 'packages', 'mcp-server', 'package.json');
  const mcpPath = join(root, '.mcp.json');

  const { version } = readJson(pkgPath, 'packages/mcp-server/package.json');
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    fail(`packages/mcp-server/package.json has no valid version (got ${JSON.stringify(version)})`);
  }
  const expected = `${PACKAGE_NAME}@${version}`;

  const text = readFileSync(mcpPath, 'utf8');
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return fail(`.mcp.json is not valid JSON: ${error.message}`);
  }
  const args = config?.mcpServers?.[SERVER_KEY]?.args;
  const index = Array.isArray(args)
    ? args.findIndex((arg) => typeof arg === 'string' && (arg === PACKAGE_NAME || arg.startsWith(`${PACKAGE_NAME}@`)))
    : -1;
  if (index === -1) fail(`.mcp.json has no ${PACKAGE_NAME} spec in mcpServers["${SERVER_KEY}"].args`);
  const current = args[index];

  if (current === expected) {
    console.log(`.mcp.json already pins ${expected}`);
    return;
  }
  if (check) {
    fail(
      `.mcp.json pins ${current} but packages/mcp-server/package.json is ${version}. ` +
        'Run `node scripts/sync-mcp-pin.mjs` and commit .mcp.json.',
    );
  }

  // Swap the one quoted string in place so indentation and key order survive.
  const needle = JSON.stringify(current);
  const occurrences = text.split(needle).length - 1;
  if (occurrences !== 1) fail(`expected exactly one occurrence of ${needle} in .mcp.json, found ${occurrences}`);
  const updated = text.replace(needle, JSON.stringify(expected));

  if (JSON.parse(updated).mcpServers[SERVER_KEY].args[index] !== expected) {
    fail('rewrite verification failed; .mcp.json left untouched');
  }
  writeFileSync(mcpPath, updated);
  console.log(`.mcp.json: ${current} -> ${expected}`);
}

main();
