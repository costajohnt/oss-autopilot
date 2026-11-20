/**
 * The scheduled overnight run's tool rules, checked as a rule set (#1937).
 *
 * The repo has no matcher to reuse, so `admitted` mirrors the semantics that
 * overnight.ts and commands/oss-overnight.md rely on. Assumptions:
 *
 * - `Bash(<pattern>)` is matched against the whole command string. `*` is any
 *   run of characters, spaces included (that is how `git * push *` reaches
 *   `git -C <dir> push`); nothing else is special, so `X *` does not match a
 *   bare `X` (the lists carry both forms).
 * - Deny beats allow.
 * - A compound command (`&&`, `||`, `;`, `|`, `&`, newline) is split and every
 *   part must pass (`cd <dir> && git ...` is denied under dontAsk).
 * - The string is matched as typed: no understanding of quotes, comments or a
 *   leading `VAR=value`.
 *
 * Where Claude Code is stricter than this, the refusals below still hold.
 * Where it is looser, this file cannot know: it tests the rule set, not the
 * product.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import {
  OVERNIGHT_ALLOWED_TOOLS,
  OVERNIGHT_DISALLOWED_TOOLS,
  OVERNIGHT_GIT_ENV,
  PUSH_DISABLED_URL,
  renderLaunchdPlist,
  isScheduleCurrent,
} from './overnight.js';

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function bashPatterns(rules: string): RegExp[] {
  return rules
    .split(',')
    .filter((rule) => rule.startsWith('Bash('))
    .map((rule) => {
      const body = rule.slice('Bash('.length, -1);
      const source = body
        .split('*')
        .map((literal) => escapeRegExp(literal))
        .join('.*');
      return new RegExp(`^${source}$`, 's');
    });
}

const ALLOW = bashPatterns(OVERNIGHT_ALLOWED_TOOLS);
const DENY = bashPatterns(OVERNIGHT_DISALLOWED_TOOLS);

function parts(command: string): string[] {
  return command
    .split(/&&|\|\||[;|&\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const isDenied = (command: string): boolean => parts(command).some((part) => DENY.some((re) => re.test(part)));

const isAdmitted = (command: string): boolean =>
  !isDenied(command) && parts(command).every((part) => ALLOW.some((re) => re.test(part)));

const CLI = 'node "/plugins/oss-autopilot/packages/core/dist/cli.bundle.cjs"';
const PR = 'https://github.com/o/r/pull/42';
const REPORT = '/home/u/.oss-autopilot/reports/overnight-2026-01-05.md.preparer.txt';

/** A deny rule matches each of these, so they stay refused even if an allow rule widens. */
const DENIED = [
  // Push, in every spelling a glob can see.
  'git push',
  'git push origin HEAD',
  'git -C /wt push',
  'git -C /wt push fork HEAD:refs/heads/x',
  'git --git-dir=/wt/.git push origin x',
  'git -C /wt send-pack git@github.com:o/r.git log',
  'git -C /wt http-push https://github.com/o/r.git log',
  'git -C /wt remote add x https://github.com/o/r.git && git -C /wt push x',
  // Config injection: an alias, an SSH command, an fsmonitor.
  'git -c core.sshCommand=evil fetch origin',
  'git -c alias.p=push p origin main',
  'git -C /wt -c core.sshCommand=evil fetch origin',
  'git -C /wt -c alias.x=!evil x status',
  'git -C /wt -c alias.p=push p origin log',
  'git -C /wt --config-env=core.sshCommand=EVIL fetch origin',
  'git clone -c core.fsmonitor=evil https://github.com/o/r.git /tmp/r',
  'git clone --config core.fsmonitor=evil https://github.com/o/r.git /tmp/r',
  // Options that name a program to run.
  'git --exec-path=/tmp/evil status',
  'git -C /wt --exec-path=/tmp/evil status',
  'git fetch --upload-pack=evil origin',
  'git -C /wt fetch --upload-pack evil origin',
  'git -C /wt fetch "--upload-pack=evil" origin',
  'git -C /wt fetch --receive-pack=evil origin',
  'git clone -u evil https://github.com/o/r.git',
  'git clone --depth 1 -u evil https://github.com/o/r.git',
  'git -C /tmp clone -u evil https://github.com/o/r.git',
  'git clone --template=/tmp/hooks https://github.com/o/r.git /tmp/r',
  "git clone 'ext::sh -c evil' /tmp/r",
  'git -C /wt fetch ext::sh -c evil',
  'git rebase --exec=evil main',
  'git -C /wt rebase --exec evil main',
  'git -C /wt rebase -x evil main',
  'git -C /wt log --ext-diff -p',
  'git -C /wt show --ext-diff HEAD',
  'git -C /wt diff --output=/home/u/.zshrc',
  // Credentials.
  'git credential fill',
  'git -C /wt credential fill',
  'git credential-osxkeychain get',
  'git -C /wt credential-osxkeychain get',
  'gh auth token',
  'gh auth status',
  'gh auth status --show-token',
  'gh auth refresh -s delete_repo',
  'security find-generic-password -s gh:github.com -w',
  'security find-internet-password -s github.com -w',
  // GitHub and registry writes.
  'gh pr create --fill',
  'gh pr comment 1 -b x',
  'gh pr merge 1',
  'gh api -X POST repos/o/r/issues',
  'gh api user',
  'gh issue view 1',
  'npm publish',
  'npm --workspaces publish',
  'pnpm publish --no-git-checks',
  'pnpm -r publish',
  // Evaluation flags and package runners.
  'node -e "x"',
  'node --eval=x',
  'node --no-warnings -p 1',
  'npm exec -- cowsay',
  'npm x cowsay',
  'pnpm dlx cowsay',
  'pnpm --dir /wt exec sh',
];

/** No allow rule matches these; nothing in the deny list is needed to refuse them. */
const NOT_ALLOWED = [
  'git config --global alias.p push',
  'git submodule update --init --recursive',
  'git remote-https origin https://github.com/o/r.git',
  'gh pr review 1 --approve',
  'gh repo fork o/r',
  'gh release create v1',
  'gh gist create x',
  'gh workflow run ci.yml',
  'cat /home/u/.config/gh/hosts.yml',
  'NODE_OPTIONS=--require=/tmp/x.js node cli.cjs',
  'OSS_AUTOPILOT_UNATTENDED= node cli.cjs post',
  'env -u OSS_AUTOPILOT_UNATTENDED node cli.cjs post',
  'npx cowsay',
  'bash -c x',
  'sh /tmp/x.sh',
  'python3 /tmp/x.py',
  'curl https://example.invalid/x',
  'cd /wt && git status',
  'git status; curl https://example.invalid/x',
  'git status | sh',
];

/** What commands/oss-overnight.md and agents/overnight-preparer.md tell the run to do. */
const PROCEDURE = [
  `${CLI} overnight run --json`,
  `${CLI} overnight record --url "${PR}" --from-report "${REPORT}" --json`,
  `${CLI} overnight implement-blocked --url "https://github.com/o/r/issues/7" --from-report "${REPORT}" --json`,
  `${CLI} local-repos --json`,
  `${CLI} issue-thread https://github.com/o/r/issues/7 --json`,
  `${CLI} guidelines mark-extracted --repo o/r`,
  `gh pr view ${PR} --json headRepositoryOwner,headRefName`,
  'gh repo view me/r --json parent',
  'gh run view 123 --log-failed',
  `gh pr checks ${PR}`,
  `gh pr diff ${PR}`,
  'git clone https://github.com/o/r.git /home/u/Documents/oss/r',
  'git -C /clone remote -v',
  'git -C /clone remote add fork https://github.com/me/r.git',
  'git -C /clone fetch origin main',
  'git -C /clone fetch fork fix-branch',
  'git -C /clone worktree add /home/u/.oss-autopilot/worktrees/o-r-42 -b overnight/42-2026-01-05 fork/fix-branch',
  'git -C /wt status',
  'git -C /wt diff',
  'git -C /wt log --oneline -20',
  'git -C /wt show HEAD',
  'git -C /wt rebase origin/main',
  'git -C /wt rebase --continue',
  'git -C /wt add -A',
  'git -C /wt add src/a.ts',
  'git -C /wt commit -m "fix: handle empty input"',
  'git -C /wt rev-parse HEAD',
  'git -C /wt merge-base HEAD origin/main',
  'git -C /wt branch --show-current',
  // Creating a branch with `switch -c` is not config injection: no `=` follows.
  'git -C /wt switch -c overnight/42-2026-01-05',
  'pnpm --dir /wt install --frozen-lockfile',
  'pnpm --dir /wt run lint',
  'pnpm --dir /wt test',
  'npm --prefix /wt ci',
  'npm --prefix /wt run lint',
  'npm --prefix /wt test',
];

/**
 * Still admitted, pinned so nobody reads the lists as a sandbox. The first
 * three are the design: the run executes the CLI bundle and a repository's
 * checks, and `Write` can put any file where the user can. The rest are the
 * matcher: `git -C * <sub>` cannot tell a subcommand from an argument, and a
 * glob does not parse quotes. The dedicated-user setup is the boundary.
 */
const ADMITTED_BY_DESIGN = [
  'node /tmp/written-by-the-run.js',
  'npm --prefix /wt run anything-in-package-json',
  'pnpm --dir /wt test',
  // An alias planted in the worktree's .git/config with Write.
  'git -C /wt p origin log',
  'git -C /wt config core.hooksPath /tmp/hooks status',
  'git -C /wt "-c" alias.p=push p origin log',
  // Outside what the Git environment rewrites (an explicit push URL, another spelling of the host).
  'git -C /wt remote set-url --push origin https://GitHub.com/me/r.git',
];

describe('overnight rule set (#1937)', () => {
  it.each(DENIED)('denies: %s', (command) => {
    expect(isDenied(command)).toBe(true);
    expect(isAdmitted(command)).toBe(false);
  });

  it.each(NOT_ALLOWED)('has no allow rule for: %s', (command) => {
    expect(isAdmitted(command)).toBe(false);
  });

  it.each(PROCEDURE)('still allows the documented procedure: %s', (command) => {
    expect(isAdmitted(command)).toBe(true);
  });

  it.each(ADMITTED_BY_DESIGN)('is not a sandbox, still admits: %s', (command) => {
    expect(isAdmitted(command)).toBe(true);
  });

  it('allows no gh auth subcommand: `gh auth status --show-token` prints the token', () => {
    const allowed = OVERNIGHT_ALLOWED_TOOLS.split(',');
    expect(allowed.some((rule) => rule.startsWith('Bash(gh auth'))).toBe(false);
    // The only wildcard that is not trailing is the one after `-C`.
    const bashRules = allowed.filter((r) => r.startsWith('Bash('));
    for (const rule of bashRules) {
      expect(rule.replace('Bash(git -C * ', 'Bash(git ')).toMatch(/^Bash\([^*]+( \*)?\)$/);
    }
  });

  it('names every new deny rule', () => {
    const rules = OVERNIGHT_DISALLOWED_TOOLS.split(',');
    for (const rule of [
      'Bash(git -c *)',
      'Bash(git * -c *=*)',
      'Bash(git * -x *)',
      'Bash(git clone -u *)',
      'Bash(git clone * -u *)',
      'Bash(git * clone -u *)',
      'Bash(git * clone * -u *)',
      'Bash(git *--config*)',
      'Bash(git *--exec*)',
      'Bash(git *--upload-pack*)',
      'Bash(git *--receive-pack*)',
      'Bash(git *--template*)',
      'Bash(git *--ext-diff*)',
      'Bash(git *--output*)',
      'Bash(git *ext::*)',
      'Bash(git *send-pack*)',
      'Bash(git *http-push*)',
      'Bash(git credential*)',
      'Bash(git * credential fill*)',
      'Bash(git *credential-*)',
      'Bash(gh auth)',
      'Bash(gh auth *)',
      'Bash(security *)',
      'Bash(npm * publish*)',
      'Bash(pnpm * publish*)',
      'Read(~/.config/gh/**)',
      'Read(~/.ssh/**)',
      'Read(~/.npmrc)',
      'Read(~/.netrc)',
      'Read(~/.git-credentials)',
    ]) {
      expect(rules).toContain(rule);
    }
    // The CLI takes the list comma-separated, so no rule may contain one.
    expect(rules.every((rule) => /^(?:\w+\(.+\)|\w+)$/.test(rule))).toBe(true);
  });
});

describe('overnight git environment (#1937)', () => {
  const plist = renderLaunchdPlist({ hour: 2, claudePath: '/bin/claude' }, '/log', '/s.json');

  it('renders every variable into the plist, none empty', () => {
    for (const [key, value] of Object.entries(OVERNIGHT_GIT_ENV)) {
      expect(value).not.toBe('');
      expect(plist).toContain(`<key>${key}</key><string>${value}</string>`);
    }
    expect(OVERNIGHT_GIT_ENV.GIT_TERMINAL_PROMPT).toBe('0');
    expect(OVERNIGHT_GIT_ENV.GIT_ALLOW_PROTOCOL.split(':')).not.toContain('ext');
  });

  // Real Git, by absolute path (the CI images and macOS have it there); skipped where it lives elsewhere.
  it.skipIf(!fs.existsSync('/usr/bin/git'))(
    'sends pushes to GitHub remotes nowhere and leaves fetch URLs alone',
    () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-git-env-'));
      const env = { ...process.env, ...OVERNIGHT_GIT_ENV };
      const git = (...args: string[]): string =>
        execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8', env });
      git('init', '-q');
      git('remote', 'add', 'https', 'https://github.com/me/r.git');
      git('remote', 'add', 'scp', 'git@github.com:me/r.git');
      git('remote', 'add', 'ssh', 'ssh://git@github.com/me/r.git');
      const remotes = git('remote', '-v');
      fs.rmSync(repo, { recursive: true, force: true });

      expect(remotes).toContain('https\thttps://github.com/me/r.git (fetch)');
      expect(remotes).toContain('scp\tgit@github.com:me/r.git (fetch)');
      const pushUrls = remotes.split('\n').filter((line) => line.endsWith('(push)'));
      expect(pushUrls).toHaveLength(3);
      expect(pushUrls.every((line) => line.includes(`\t${PUSH_DISABLED_URL}me/r.git `))).toBe(true);
    },
  );

  it('isScheduleCurrent accepts what this version renders and rejects an older rule set or environment', () => {
    expect(isScheduleCurrent(plist)).toBe(true);
    expect(isScheduleCurrent(plist.replace('Bash(security *),', ''))).toBe(false);
    expect(
      isScheduleCurrent(plist.replace(',Bash(gh repo view *)', ',Bash(gh repo view *),Bash(gh auth status *)')),
    ).toBe(false);
    expect(isScheduleCurrent(plist.replace('<key>GIT_CONFIG_COUNT</key>', '<key>OLD</key>'))).toBe(false);
  });
});
