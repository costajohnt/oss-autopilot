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
 * Limit: a text scan. `mktemp`, `$TMPDIR`, `/var/tmp` and `/private/tmp` fail
 * too, but a draft staged in some other shared directory is not seen.
 *
 * Posting goes through this flow, not an external drafting skill: the
 * `draft-review-post` skill is not shipped here, stages outside the draft
 * directory and skips `--expect-sha256`, so naming it fails too (#2009).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROMPT_DIRS = ['commands', 'workflows', 'agents', 'skills'];

/** Key: `<file> <path prefix>`. Value: why this `/tmp` use is scratch, not a draft. */
const ALLOWED_TMP: Record<string, string> = {
  'commands/oss-dashboard.md /tmp/oss-dashboard-build.log': 'build log, only tailed to show an error',
  'commands/oss-dashboard.md /tmp/oss-dashboard-cli-build.log': 'build log, only tailed to show an error',
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

describe('prompt files use no other shared temp location (#1930)', () => {
  const OTHER_SHARED_TEMP = /\bmktemp\b|\$\{?TMPDIR\b|\/(?:var|private)\/tmp\b/g;

  it('the pattern matches mktemp, $TMPDIR and the other system temp directories', () => {
    // Joined from parts: a literal system temp path here trips the linter's own shared-directory rule.
    const systemTemp = ['var', 'private'].map((top) => ['', top, 'tmp', 'x'].join('/'));
    const sample = ['f=$(mktemp)', '"$TMPDIR/x"', '${TMPDIR:-x}', ...systemTemp].join(' ');
    expect(sample.match(OTHER_SHARED_TEMP)).toHaveLength(5);
  });

  it('no prompt file uses mktemp, $TMPDIR, /var/tmp or /private/tmp', () => {
    expect(findInPrompts(OTHER_SHARED_TEMP), 'Use `draft path` instead of a shared temp location').toEqual([]);
  });
});

describe('prompt files do not hand drafts to an external skill (#2009)', () => {
  /** The skill's name, also spelled with spaces or underscores, any case. */
  const SKILL_NAME = /draft[\s_-]?review[\s_-]?post/gi;

  it('the name pattern matches the usual spellings', () => {
    expect('draft-review-post Draft Review Post draft_review_post draftreviewpost'.match(SKILL_NAME)).toHaveLength(4);
  });

  it('no prompt file names the draft-review-post skill', () => {
    expect(
      findInPrompts(SKILL_NAME),
      'Stage the text with `draft path` / `draft show` and post it with `--body-file` and `--expect-sha256` ' +
        '(see "Draft Files" in workflows/reference.md)',
    ).toEqual([]);
  });
});

describe('a file handed to post, claim or guidelines store is pinned to the approved text (#1930)', () => {
  const FILE_FLAG = /--(?:body|from)-file\b/;
  /** `post <url>` / `claim <url>` with a placeholder or real URL, or `guidelines store`; not `draft-review-post`. */
  const INVOCATION = /(?<![\w-])(?:post|claim)\s+(?:[<{]|https:)|guidelines store\b/;

  const fileInvocations = PROMPT_FILES.flatMap((file) =>
    readPrompt(file)
      .split('\n')
      .filter((line) => FILE_FLAG.test(line) && INVOCATION.test(line))
      .map((line) => `${file}: ${line.trim()}`),
  );

  it('sanity: the scan finds the documented invocations', () => {
    expect(fileInvocations.length).toBeGreaterThanOrEqual(5);
    expect(INVOCATION.test('Route through `draft-review-post`. Never post directly')).toBe(false);
  });

  it('every such line also carries --expect-sha256', () => {
    const unpinned = fileInvocations.filter((line) => !line.includes('--expect-sha256'));
    expect(unpinned, 'Add --expect-sha256 <data.sha256> from `draft show`').toEqual([]);
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

describe('prompt files read GitHub threads through the fenced commands (#2046)', () => {
  /**
   * `gh issue view` / `gh pr view` (also `gh issue -R o/r view`) asking for the
   * comments with `--comments`, `-c` or a `--json` list naming `comments`, in
   * the same code span or line (a backslash continues the line): its output
   * is not fenced.
   */
  const RAW_THREAD =
    /\bgh\s+(?:issue|pr)\s+(?:(?:-R\s+|--repo[\s=])[\w./-]+\s+)?view\b(?:[^\n`]|\\\n)*?\s(?:--comments\b|-c(?![\w-])|--json[\s=]+["']?[\w,]*\bcomments\b)/g;

  it('the pattern matches a raw thread read and skips the fenced commands', () => {
    const sample = [
      '`gh pr view {prUrl} --comments`',
      '`gh issue view {issueUrl} --repo o/r --comments`',
      '`gh pr view 7 -c`',
      '`gh issue view 7 -R o/r --json state,comments,body`',
      '`gh pr view 7 --json=comments`',
      '`gh issue -R o/r view 7 --comments`',
      'gh pr view 7 \\\n  --repo o/r --comments',
      '`gh pr view {prUrl} --json commits` and `comments {prUrl} --comments`',
      '`gh issue view 7 -R o/r --json state,assignees`, `gh pr view 7 --json commits,-c-x`',
      '`issue-thread {issueUrl} --json`, raw `gh issue view` output is not fenced',
    ].join('\n');
    expect(sample.match(RAW_THREAD)).toHaveLength(7);
  });

  it('no prompt file reads a thread with raw `gh issue view --comments` or `gh pr view --comments`', () => {
    expect(
      findInPrompts(RAW_THREAD),
      'Read an issue thread with `issue-thread <url> --json` and a PR thread with `comments <pr-url> --json` ' +
        "(add `--include-own` for the user's own comments): both fence every body (workflows/reference.md)",
    ).toEqual([]);
  });
});
