/**
 * Tool rules and Git environment of the scheduled overnight run
 * (commands/oss-overnight.md, "Scheduling").
 *
 * How Claude Code matches a `Bash(<pattern>)` rule, per its permissions
 * documentation:
 *
 * - `*` matches any text, spaces included, at any position. Only the literal
 *   text before the first `*` limits a rule.
 * - A trailing ` *` that is the rule's only wildcard also matches the bare
 *   command, so the paired bare rules below are redundant and harmless.
 * - A compound command is split on `&&`, `||`, `;`, `|`, `|&`, `&` and
 *   newlines. Every part must be allowed; a deny applies when any part
 *   matches, inside a subshell or a command substitution too.
 * - Deny is checked before allow, and an allow cannot carve an exception out
 *   of a deny.
 * - `Read(~/path)` denies cover the file tools and, best effort, Grep, Glob and
 *   the file commands Bash recognises. A subprocess can still read the file.
 *
 * The same documentation says argument patterns are fragile and not a
 * security boundary. That holds here (#1937): the lists filter spelling, not
 * capability. `node`, `pnpm` and `npm` stay because the CLI bundle and a
 * repository's test suite are already arbitrary code, and `Write` can plant a
 * script, a hook or an alias. The `*` in `git -C * <sub>` (which Claude Code
 * warns about at startup, a wildcard before the subcommand) also admits any
 * other subcommand whose arguments end in an allowed word. The boundary is a
 * dedicated user with no push credentials ("Split users" in the command doc),
 * or an OS sandbox.
 */

/** The subcommands the procedure uses; never `push`. */
const GIT_SUBCOMMANDS = [
  'clone',
  'fetch',
  'worktree',
  'checkout',
  'switch',
  'branch',
  'rebase',
  'merge-base',
  'status',
  'diff',
  'log',
  'show',
  'add',
  'commit',
  'rev-parse',
  'remote',
];

/**
 * The read side of `gh` only: no `gh api` (it can POST), no `gh auth` (it can
 * print the token), no `gh issue view` (raw output is unfenced; the
 * `issue-thread` CLI command is the fenced read, #1932).
 */
const GH_READ_SUBCOMMANDS = ['pr view', 'pr checks', 'pr diff', 'pr list', 'run view', 'run list', 'repo view'];

/** `git <tail>` as the first argument, and anywhere after it (`git -C <dir> <tail>`). */
function gitAnywhere(tail: string): string[] {
  return [`Bash(git ${tail})`, `Bash(git * ${tail})`];
}

/**
 * Deny list layered under the allowlist: even if a future allow rule widens,
 * these never run unattended. `AskUserQuestion` is denied because nobody can
 * answer; the preparer agent reports `blocked` instead.
 */
export const OVERNIGHT_DISALLOWED_TOOLS = [
  // Spelled out, not built with gitAnywhere: unattended-write-guard.test.ts
  // reads a quoted `push` on its own as a spawned push.
  'Bash(git push)',
  'Bash(git push *)',
  'Bash(git * push)',
  'Bash(git * push *)',
  'Bash(gh pr create *)',
  'Bash(gh pr comment *)',
  'Bash(gh pr merge *)',
  'Bash(gh pr close *)',
  'Bash(gh pr edit *)',
  'Bash(gh pr ready *)',
  'Bash(gh issue create *)',
  'Bash(gh issue comment *)',
  'Bash(gh issue close *)',
  'Bash(gh issue view)',
  'Bash(gh issue view *)',
  'Bash(gh run rerun *)',
  'Bash(gh api *)',
  // Registry writes: a token in ~/.npmrc would let them ship a release
  // unattended. Also after a leading flag (`pnpm -r publish`), as a whole
  // word, so `npm run publish:docs` and a package named `publish-utils` pass.
  'Bash(npm publish)',
  'Bash(npm publish *)',
  'Bash(npm * publish)',
  'Bash(npm * publish *)',
  'Bash(npm unpublish *)',
  'Bash(npm deprecate *)',
  'Bash(pnpm publish)',
  'Bash(pnpm publish *)',
  'Bash(pnpm * publish)',
  'Bash(pnpm * publish *)',
  // Direct shell escapes inside the allowed programs (#1728): `npm exec` is
  // npx, `pnpm dlx` and `pnpm exec` run any package, `node -e` runs any
  // JavaScript. Each could spawn a push and void the push denies above.
  'Bash(npm exec)',
  'Bash(npm exec *)',
  'Bash(npm x)',
  'Bash(npm x *)',
  'Bash(npm * exec *)',
  'Bash(npm * x *)',
  'Bash(pnpm dlx *)',
  'Bash(pnpm * dlx *)',
  'Bash(pnpm exec)',
  'Bash(pnpm exec *)',
  'Bash(pnpm * exec *)',
  'Bash(node -e *)',
  'Bash(node --eval *)',
  'Bash(node -p *)',
  'Bash(node -pe *)',
  'Bash(node --print *)',
  'Bash(node * -e *)',
  'Bash(node * --eval *)',
  'Bash(node * -p *)',
  'Bash(node * -pe *)',
  'Bash(node * --print *)',
  // The `=` forms take no space: `node --eval=<js>` runs like `node --eval <js>`.
  'Bash(node --eval=*)',
  'Bash(node * --eval=*)',
  'Bash(node --print=*)',
  'Bash(node * --print=*)',
  // Git option forms that run a program or inject config from an allowed
  // subcommand (#1937). These trip on the plain spellings, including the
  // abbreviations Git accepts (`--upl`, clone's `--u`, `--co` and `--te`,
  // rebase's `--ex`) and a short option with its value attached (`-x<cmd>`).
  // An option with quotes or escapes inside it (`--upl"oad-pack"`) still gets
  // through. They also match the same text inside a quoted argument, which is
  // why the preparer commits with `-F <file>` and never `-m`.
  'Bash(git -c *)',
  // `-c name=value` needs its `=`, so `switch -c <branch>` still works.
  'Bash(git * -c*=*)',
  'Bash(git * -x*)',
  'Bash(git *--config*)',
  'Bash(git *--exec*)',
  'Bash(git *--upl*)',
  'Bash(git *--receive-pack*)',
  'Bash(git *--template*)',
  'Bash(git *--ext-diff*)',
  'Bash(git *--output*)',
  'Bash(git *ext::*)',
  ...['clone -u*', 'clone * -u*', 'clone *--u*', 'clone *--co*', 'clone *--te*', 'rebase *--ex*'].flatMap((tail) =>
    gitAnywhere(tail),
  ),
  // Push by another name, and anything that hands out a credential. Whole
  // words after a space, so a path such as `src/credential-store.ts` or a
  // repository named `git-credential-manager` does not match.
  'Bash(git send-pack*)',
  'Bash(git http-push*)',
  'Bash(git credential*)',
  ...['send-pack', 'send-pack *', 'http-push', 'http-push *', 'credential', 'credential *'].map(
    (tail) => `Bash(git * ${tail})`,
  ),
  'Bash(git * credential-* get*)',
  'Bash(gh auth)',
  'Bash(gh auth *)',
  'Bash(security *)',
  // Credential files, kept from the file tools (see the header for the limit).
  'Read(~/.config/gh/**)',
  'Read(~/.ssh/**)',
  'Read(~/.npmrc)',
  'Read(~/.netrc)',
  'Read(~/.git-credentials)',
  'AskUserQuestion',
].join(',');

/**
 * Tools the headless run may use without a prompt: enumerated, not
 * wildcarded. No `bash`, `sh` or `npx`.
 */
export const OVERNIGHT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Task',
  // Both the bare and the `-C <dir>` forms: a preparer's worktree is never its
  // cwd, and `cd <dir> && git ...` is denied under dontAsk, so without `-C`
  // every preparer blocks (#1697).
  ...GIT_SUBCOMMANDS.flatMap((sub) => [
    `Bash(git ${sub})`,
    `Bash(git ${sub} *)`,
    `Bash(git -C * ${sub})`,
    `Bash(git -C * ${sub} *)`,
  ]),
  ...GH_READ_SUBCOMMANDS.map((sub) => `Bash(gh ${sub} *)`),
  'Bash(node *)',
  'Bash(pnpm *)',
  'Bash(npm *)',
].join(',');

export const PUSH_DISABLED_URL = 'https://push-disabled.invalid/';

/** The spellings of a GitHub remote whose pushes are rewritten; any other spelling is not. */
export const GITHUB_PUSH_PREFIXES = [
  'https://github.com/',
  'git@github.com:',
  'ssh://git@github.com/',
  'ssh://git@github.com:22/',
  'git@ssh.github.com:',
];

/**
 * Git environment for the scheduled run (#1937): a seat belt under the deny
 * list, not a boundary, because code the run executes can unset it.
 * `pushInsteadOf` sends a push to one of the prefixes above to a host that
 * cannot resolve while fetches keep working; a remote with an explicit
 * `pushurl`, or a URL spelled another way, is not rewritten.
 * `GIT_ALLOW_PROTOCOL` drops the `ext::` transport, which runs a command.
 * Values are never empty: a plist entry launchd dropped would make every Git
 * call fail on a missing value.
 */
export const OVERNIGHT_GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh',
  GIT_CONFIG_COUNT: String(GITHUB_PUSH_PREFIXES.length),
  ...Object.fromEntries(
    GITHUB_PUSH_PREFIXES.flatMap((prefix, i) => [
      [`GIT_CONFIG_KEY_${i}`, `url.${PUSH_DISABLED_URL}.pushInsteadOf`],
      [`GIT_CONFIG_VALUE_${i}`, prefix],
    ]),
  ),
};
