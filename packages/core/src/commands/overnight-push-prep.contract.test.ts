/**
 * --json contract test for `overnight push-prep` (#1698, pattern from #965).
 *
 * Goldens pin the OvernightPushPrepOutput shape (a pushed entry, a skipped
 * entry, and a dry-run plan) so a scheduler or the plugin reading it cannot
 * drift from the CLI silently; the Zod schema is checked against the same
 * output so the schema and the hand-written interface stay in step.
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/overnight-push-prep.contract.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const state = vi.hoisted(() => ({ last: undefined as unknown }));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => ({
      getLastOvernight: () => state.last,
      setLastOvernight: (r: unknown) => {
        state.last = r;
      },
      getState: () => ({ config: { githubUsername: 'octocat' } }),
    }),
    getOctokit: () => ({
      users: { getAuthenticated: async () => ({ data: { login: 'octocat' } }) },
      repos: { get: async () => ({ data: { fork: true, owner: { login: 'octocat' }, full_name: 'octocat/widget' } }) },
      pulls: { get: async () => ({ data: { head: { ref: 'fix-lint' } } }) },
    }),
    requireGitHubToken: () => 'tok',
    maybeCheckpoint: async () => 'Gist checkpoint push failed after retry',
  };
});

import { runOvernightPushPrep } from './overnight-push-prep.js';
import { OvernightPushPrepOutputSchema } from '../formatters/json.js';

const mockExecFileSync = vi.mocked(execFileSync);

let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-prep-contract-'));
  state.last = {
    runAt: '2026-09-18T02:00:00.000Z',
    reportPath: path.join(tmp, 'overnight-2026-09-18.md'),
    prepareCount: 2,
    judgmentCount: 0,
    prepared: [
      {
        url: 'https://github.com/upstream-org/widget/pull/42',
        branch: 'overnight/42-2026-09-18',
        worktree: tmp,
        note: 'fixed lint',
        recordedAt: '2026-09-18T02:10:00.000Z',
      },
      {
        url: 'https://github.com/upstream-org/widget/pull/43',
        branch: 'overnight/43-2026-09-18',
        recordedAt: '2026-09-18T02:20:00.000Z',
      },
    ],
  };
  mockExecFileSync.mockImplementation(((_cmd: string, args: string[]) =>
    args[2] === 'remote' ? 'origin\thttps://github.com/octocat/widget.git (push)\n' : '') as never);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Replace the per-run temp dir so the golden is stable across machines. */
function stable(out: object): string {
  return JSON.stringify(out, null, 2).replaceAll(tmp, '/home/user/.oss-autopilot/reports');
}

describe('overnight push-prep --json contract', () => {
  it('pushed output matches the golden shape and the Zod schema', async () => {
    const result = await runOvernightPushPrep({ dryRun: false });
    expect(OvernightPushPrepOutputSchema.safeParse(result).success).toBe(true);
    await expect(stable(result)).toMatchFileSnapshot('./__golden__/overnight.push-prep.pushed.json');
  });

  it('dry-run output matches the golden shape and the Zod schema', async () => {
    const result = await runOvernightPushPrep({ dryRun: true });
    expect(OvernightPushPrepOutputSchema.safeParse(result).success).toBe(true);
    await expect(stable(result)).toMatchFileSnapshot('./__golden__/overnight.push-prep.dry-run.json');
  });
});
