/**
 * CI gate (#1930): the prompt layer never stages text under `/tmp`, and never
 * puts text to post or store on a shell command line.
 *
 * Text posted or stored under the user's name goes through the tool's own
 * draft directory (`draft path`, `draft show`, then `--body-file` or
 * `--from-file` with `--expect-sha256`; see "Draft Files" in
 * workflows/reference.md). `/tmp` is shared: another local user can pre-create
 * or swap a file there between the user's approval and the command reading it.
 *
 * A `/tmp/` path in a prompt file fails unless it is on the allowlist below
 * with the reason it carries no text that is later posted, stored or committed.
 *
 * Limit: a text scan. It does not see a path built from variables (`$TMPDIR`,
 * `mktemp`), or a draft staged outside `/tmp` in some other shared directory.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROMPT_DIRS = ['commands', 'workflows', 'agents', 'skills'];

/** Key: `<file> <path prefix>`. Value: why this `/tmp` use is scratch, not a draft. */
const ALLOWED_TMP: Record<string, string> = {
  'commands/oss-dashboard.md /tmp/oss-dashboard-build.log': 'build log, only tailed to show an error',
  'commands/oss-search.md /tmp/oss-search-cli-build.log': 'build log, only tailed to show an error',
  'commands/setup-oss.md /tmp/oss-setup-cli-build.log': 'build log, only tailed to show an error',
  'commands/oss.md /tmp/oss-startup-stderr.log': 'stderr of the startup command, read for diagnostics only',
  'workflows/startup-and-build.md /tmp/oss-startup-cli-build.log': 'build log, only tailed to show an error',
  'workflows/startup-and-build.md /tmp/oss-dashboard-build.log': 'build log, grepped and tailed to show an error',
  'workflows/startup-and-build.md /tmp/oss-startup-stderr.log': 'stderr of the startup command, diagnostics only',
  'workflows/pre-commit-review.md /tmp/pre-format.diff':
    'baseline diff compared against after a formatter run; never posted, stored or committed',
  'agents/pr-health-checker.md /tmp/my-changes.patch':
    "backup of the user's own diff, re-applied by hand; never posted or stored",
  'commands/plan-ready.md /tmp/oss-autopilot-plans/':
    'implementation plan the review loop reads; guides local work, not fed to a posting or storing command',
  'commands/plan-ready.md /tmp/some-plan.md': 'example of a user-supplied plan path',
  'workflows/plan-review.md /tmp/oss-autopilot-plans/':
    'implementation plan the review loop reads; guides local work, not fed to a posting or storing command',
};

/** A `/tmp/...` path, but not the `tmp` directory of some other path (`~/.oss-autopilot/tmp/x`). */
const TMP_PATH = /(?<![\w.~-])\/tmp\/[\w.{}<>$/-]*/g;

function listMarkdown(dir: string): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.posix.join(dir, name.split(path.sep).join('/')));
}

const PROMPT_FILES = PROMPT_DIRS.flatMap((dir) => listMarkdown(dir));

function readPrompt(file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

function isAllowedTmp(file: string, tmpPath: string): boolean {
  return Object.keys(ALLOWED_TMP).some((key) => {
    const [allowedFile, prefix] = key.split(' ', 2);
    return allowedFile === file && tmpPath.startsWith(prefix);
  });
}

/** `<file>: <match>` for every match of the global `pattern` in the prompt files, minus allowlisted `/tmp` paths. */
function findInPrompts(pattern: RegExp): string[] {
  return PROMPT_FILES.flatMap((file) =>
    (readPrompt(file).match(pattern) ?? [])
      .filter((match) => !isAllowedTmp(file, match))
      .map((match) => `${file}: ${match}`),
  );
}

describe('prompt files do not stage drafts under /tmp (#1930)', () => {
  it('sanity: the scan sees the prompt layer', () => {
    expect(PROMPT_FILES.length).toBeGreaterThan(20);
    expect(PROMPT_FILES).toContain('workflows/extract-learnings.md');
    expect(PROMPT_FILES).toContain('skills/pr-etiquette/SKILL.md');
  });

  it('the path pattern matches a /tmp path and skips the draft directory', () => {
    const sample = 'cat /tmp/a-{pr}.md >/tmp/b.log `~/.oss-autopilot/tmp/c.md` "$HOME/x/tmp/d"';
    expect(sample.match(TMP_PATH)?.map((found) => found.slice(1))).toEqual(['tmp/a-{pr}.md', 'tmp/b.log']);
  });

  it('every /tmp path in a prompt file is an allowlisted scratch use', () => {
    const offenders = findInPrompts(TMP_PATH);
    expect(
      offenders,
      'Stage text for posting or storing with `draft path` (see "Draft Files" in workflows/reference.md), ' +
        'or add a scratch use to ALLOWED_TMP with its reason',
    ).toEqual([]);
  });

  it('every allowlist entry is still in use', () => {
    const stale = Object.keys(ALLOWED_TMP).filter((key) => {
      const [file, prefix] = key.split(' ', 2);
      return !readPrompt(file).includes(prefix);
    });
    expect(stale, 'Remove these entries from ALLOWED_TMP').toEqual([]);
  });
});

describe('prompt files do not put text to post or store on a command line (#1930)', () => {
  it('no `guidelines store --content` with a quoted or placeholder value', () => {
    expect(findInPrompts(/--content\s+["'<{$][^\n]{0,40}/g)).toEqual([]);
  });

  it('no `post <url>` followed by a quoted message', () => {
    const quotedPost = /\bpost\s+(?:<[^>\n]+>|[{$]\S+|\S*github\.com\S*)\s+["'][^\n]{0,40}/g;
    expect('cli.bundle.cjs" post <pr-url> "<message>"'.match(quotedPost)).not.toBeNull();
    expect('post <url> --body-file <draft-path> --expect-sha256 <sha256>'.match(quotedPost)).toBeNull();
    expect(findInPrompts(quotedPost)).toEqual([]);
  });
});
