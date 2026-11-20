/**
 * The scheduled overnight run's tool rules, checked as a rule set (#1937).
 *
 * The repo has no matcher to reuse, so `isAdmitted` mirrors what Claude
 * Code's permissions documentation says about `Bash(<pattern>)` rules:
 *
 * - `*` matches any text, spaces included, at any position.
 * - A trailing ` *` that is the rule's only wildcard also matches the bare
 *   command (`ls *` matches `ls`).
 * - Deny is checked before allow.
 * - A compound command is split on `&&`, `||`, `;`, `|`, `|&`, `&` and
 *   newlines, and every part must be allowed. A deny applies when any part
 *   matches, inside a subshell or a command substitution too, so this matcher
 *   also splits on `(`, `)`, `$(` and backticks.
 *
 * Not modelled: quotes, comments, a leading `VAR=value`, and whatever else
 * the product normalises. The documentation calls argument patterns fragile
 * and not a security boundary; this file tests the rule set, not the product.
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
      // `X *` with no other wildcard: the bare command matches too.
      if (body.endsWith(' *') && body.indexOf('*') === body.length - 1) {
        return new RegExp(`^${escapeRegExp(body.slice(0, -2))}(?: .*)?$`, 's');
      }
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
    .split(/&&|\|\||\$\(|[;|&\n()`]/)
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
  // The abbreviations Git accepts, and a short option with its value attached.
  'git -C /wt fetch --upl=evil origin',
  'git clone --u=evil https://github.com/o/r.git /tmp/r',
  'git clone --up evil https://github.com/o/r.git /tmp/r',
  'git -C /tmp clone --u=evil https://github.com/o/r.git',
  'git clone --conf core.fsmonitor=evil https://github.com/o/r.git /tmp/r',
  'git clone --co core.fsmonitor=evil https://github.com/o/r.git /tmp/r',
  'git clone --te=/tmp/hooks https://github.com/o/r.git /tmp/r',
  'git clone -uevil https://github.com/o/r.git',
  'git clone -ccore.fsmonitor=evil https://github.com/o/r.git /tmp/r',
  'git -C /wt rebase --ex evil main',
  'git -C /wt rebase -xevil main',
  // Inside a substitution or a subshell.
  'git -C /wt status $(git -C /wt push fork x)',
  '(gh auth token)',
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

/**
 * The denies match the same text inside a quoted argument. A commit message
 * on the command line can therefore be refused, which is why the preparer
 * writes the message to a file and commits with `-F` (see PROCEDURE).
 */
const REFUSED_COMMIT_MESSAGES = [
  'git -C /wt commit -m "fix: honour the --output flag"',
  'git -C /wt commit -m "fix: read --config before --exec"',
  'git -C /wt commit -m "docs: the ext:: transport"',
  'git -C /wt commit -m "fix: retry the push once"',
  'git -C /wt commit -m "fix: credential lookup on macOS"',
  'git -C /wt commit -m "test: run with -c core.pager=cat"',
];

/**
 * Ordinary preparer commands that share a word with a deny rule: a repository
 * or a file named after one, a script or package named like a registry write.
 * A deny that matches one of these blocks a whole night's work on that repo.
 */
const LEGITIMATE = [
  'git clone https://github.com/git-ecosystem/git-credential-manager.git /home/u/Documents/oss/git-credential-manager',
  'git -C /home/u/Documents/oss/git-credential-manager fetch origin main',
  'git -C /home/u/.oss-autopilot/worktrees/git-ecosystem-git-credential-manager-42 status',
  'git -C /home/u/.oss-autopilot/worktrees/git-ecosystem-git-credential-manager-42 commit -F /home/u/.oss-autopilot/worktrees/git-ecosystem-git-credential-manager-42.commit-msg.txt',
  'git -C /wt add src/credential-store.ts',
  'git -C /wt add credential-store.ts',
  'git -C /wt add send-pack.c',
  'git -C /wt diff -- builtin/send-pack.c http-push.c',
  'git -C /wt log --oneline -- src/credential-store.ts',
  'git -C /wt add docs/publish.md',
  'git -C /wt checkout fix/push-retry',
  'git -C /wt status --untracked-files=no',
  'git -C /wt diff --cached',
  'git -C /wt rebase --continue',
  'npm --prefix /wt run publish:docs',
  'pnpm --filter publish-utils test',
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
  // The message is in a file the preparer wrote with the Write tool: nothing in it can meet a deny rule.
  'git -C /wt commit -F /home/u/.oss-autopilot/worktrees/o-r-42.commit-msg.txt',
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
 * glob does not parse quotes, so an option with quotes inside it or bundled
 * behind another short option passes. The dedicated-user setup is the boundary.
 */
const ADMITTED_BY_DESIGN = [
  'node /tmp/written-by-the-run.js',
  'npm --prefix /wt run anything-in-package-json',
  'pnpm --dir /wt test',
  // An alias planted in the worktree's .git/config with Write.
  'git -C /wt p origin log',
  'git -C /wt config core.hooksPath /tmp/hooks status',
  'git -C /wt "-c" alias.p=push p origin log',
  // Quotes inside an option, and a short option bundled behind another.
  'git -C /wt fetch --up"load-pack"=evil origin',
  'git clone --"u"=evil https://github.com/o/r.git /tmp/r',
  'git -C /wt rebase -"x" evil main',
  'git clone -qu evil https://github.com/o/r.git /tmp/r',
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

  it.each(LEGITIMATE)('does not block an ordinary command: %s', (command) => {
    expect(isAdmitted(command)).toBe(true);
  });

  it.each(REFUSED_COMMIT_MESSAGES)('refuses a message on the command line, hence `commit -F`: %s', (command) => {
    expect(isDenied(command)).toBe(true);
  });

  it('matches a bare command with a trailing-wildcard rule, as the documentation says', () => {
    expect(isAdmitted('gh pr view')).toBe(true);
    expect(isDenied('gh auth')).toBe(true);
    expect(isDenied('security')).toBe(true);
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
      'Bash(git * -c*=*)',
      'Bash(git * -x*)',
      'Bash(git clone -u*)',
      'Bash(git clone * -u*)',
      'Bash(git * clone -u*)',
      'Bash(git * clone * -u*)',
      'Bash(git clone *--u*)',
      'Bash(git * clone *--u*)',
      'Bash(git clone *--co*)',
      'Bash(git * clone *--co*)',
      'Bash(git clone *--te*)',
      'Bash(git * clone *--te*)',
      'Bash(git rebase *--ex*)',
      'Bash(git * rebase *--ex*)',
      'Bash(git *--config*)',
      'Bash(git *--exec*)',
      'Bash(git *--upl*)',
      'Bash(git *--receive-pack*)',
      'Bash(git *--template*)',
      'Bash(git *--ext-diff*)',
      'Bash(git *--output*)',
      'Bash(git *ext::*)',
      'Bash(git send-pack*)',
      'Bash(git * send-pack)',
      'Bash(git * send-pack *)',
      'Bash(git http-push*)',
      'Bash(git * http-push)',
      'Bash(git * http-push *)',
      'Bash(git credential*)',
      'Bash(git * credential)',
      'Bash(git * credential *)',
      'Bash(git * credential-* get*)',
      'Bash(gh auth)',
      'Bash(gh auth *)',
      'Bash(security *)',
      'Bash(npm * publish)',
      'Bash(npm * publish *)',
      'Bash(pnpm * publish)',
      'Bash(pnpm * publish *)',
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
      git('remote', 'add', 'ssh22', 'ssh://git@github.com:22/me/r.git');
      git('remote', 'add', 'alt', 'git@ssh.github.com:me/r.git');
      const remotes = git('remote', '-v');
      fs.rmSync(repo, { recursive: true, force: true });

      expect(remotes).toContain('https\thttps://github.com/me/r.git (fetch)');
      expect(remotes).toContain('scp\tgit@github.com:me/r.git (fetch)');
      const pushUrls = remotes.split('\n').filter((line) => line.endsWith('(push)'));
      expect(pushUrls).toHaveLength(5);
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
    expect(isScheduleCurrent(plist.replace('<string>dontAsk</string>', '<string>acceptEdits</string>'))).toBe(false);
    const withUserSettings = plist.replace('<string></string>', '<string>user</string>');
    expect(withUserSettings).not.toBe(plist);
    expect(isScheduleCurrent(withUserSettings)).toBe(false);
  });
});
