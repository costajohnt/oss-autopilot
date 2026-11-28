/**
 * CI gate (#1930, #2051): the prompt layer never writes under `/tmp`, and
 * never puts text to post or store on a shell command line.
 *
 * Text posted or stored under the user's name goes through the tool's own
 * draft directory (`draft path`, `draft show`, then `--body-file` or
 * `--from-file` with `--expect-sha256`; see "Draft Files" in
 * workflows/draft-files.md). `/tmp` is shared: another local user can pre-create
 * or swap a file there between the user's approval and the command reading it.
 *
 * Any `/tmp/` path in a prompt file fails, with no allowlist (#2051): a build
 * log or a diff the flow reads back goes to `~/.oss-autopilot/logs/` (created
 * with `mkdir -p -m 700`), and a capture nothing reads goes to `/dev/null`.
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

/** `<file>: <match>` for every match of the global `pattern` in the prompt files. */
function findInPrompts(pattern: RegExp): string[] {
  return PROMPT_FILES.flatMap((file) => (readPrompt(file).match(pattern) ?? []).map((match) => `${file}: ${match}`));
}

describe('prompt files do not write under /tmp (#1930, #2051)', () => {
  it('sanity: the scan sees the prompt layer', () => {
    expect(PROMPT_FILES.length).toBeGreaterThan(20);
    expect(PROMPT_FILES).toContain('workflows/extract-learnings.md');
    expect(PROMPT_FILES).toContain('skills/pr-etiquette/SKILL.md');
  });

  it('the path pattern matches a /tmp path and skips the draft directory', () => {
    const sample =
      'cat /tmp/a-{pr}.md >/tmp/b.log 2>/tmp/e.log `~/.oss-autopilot/tmp/c.md` "$HOME/x/tmp/d" ~/.oss-autopilot/logs/f.diff';
    expect(sample.match(TMP_PATH)?.map((found) => found.slice(1))).toEqual(['tmp/a-{pr}.md', 'tmp/b.log', 'tmp/e.log']);
  });

  it('no prompt file names a /tmp path', () => {
    expect(
      findInPrompts(TMP_PATH),
      'Stage text for posting or storing with `draft path` (see "Draft Files" in workflows/draft-files.md); ' +
        'write a log or diff the flow reads back under ~/.oss-autopilot/logs/ (mkdir -p -m 700 first), ' +
        'and send a capture nothing reads to /dev/null',
    ).toEqual([]);
  });
});

describe('the draft and approval protocol is written once, in workflows/draft-files.md (#2051)', () => {
  const PROTOCOL_FILE = 'workflows/draft-files.md';
  /** A citation of a protocol section that sends the reader to reference.md instead. */
  const STALE_CITATION = /"(?:Draft Files|Before drafting a comment|Approval to post)"[^"\n]{0,20}`workflows\/reference\.md`/g;
  /** The approval phrase list; only the protocol file may state it. */
  const PHRASE_LIST = /"yes, post"/g;

  it('the protocol file has every section', () => {
    const text = readPrompt(PROTOCOL_FILE);
    expect(text).toMatch(/^## Draft Files \(#1930\)$/m);
    expect(text).toMatch(/^### Before drafting a comment \(#2009\)$/m);
    expect(text).toMatch(/^### Approval to post \(#2009\)$/m);
  });

  it('no other prompt file has a heading for "Before drafting a comment" or "Approval to post"', () => {
    const heading = /^#{1,6} (?:Before drafting a comment|Approval to post)\b.*$/gm;
    expect(findInPrompts(heading).filter((hit) => !hit.startsWith(`${PROTOCOL_FILE}:`))).toEqual([]);
  });

  it('only the protocol file states the approval phrase list', () => {
    expect(readPrompt(PROTOCOL_FILE).match(PHRASE_LIST)).toHaveLength(1);
    expect(findInPrompts(PHRASE_LIST).filter((hit) => !hit.startsWith(`${PROTOCOL_FILE}:`))).toEqual([]);
  });

  it('every citation of a protocol section names the protocol file', () => {
    expect('("Draft Files" in `workflows/reference.md`)'.match(STALE_CITATION)).toHaveLength(1);
    expect('"Approval to post" (`workflows/draft-files.md`)'.match(STALE_CITATION)).toBeNull();
    expect(findInPrompts(STALE_CITATION), `Cite ${PROTOCOL_FILE}`).toEqual([]);
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
        '(see "Draft Files" in workflows/draft-files.md)',
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
   * A `gh issue view` / `gh pr view` command (also `gh issue -R o/r view`) up
   * to the end of its code span or line; a backslash continues the line.
   */
  const GH_VIEW = /\bgh\s+(?:issue|pr)\s+(?:(?:-R\s+|--repo[\s=])[\w./-]+\s+)?view\b(?:\\\n|[^\n`])*/g;
  /** Asks for the comments: `--comments`, `-c`, or a `--json` list naming `comments`. Its output is not fenced. */
  const WANTS_COMMENTS = /\s(?:--comments\b|-c(?![\w-])|--json[\s=]+["']?[\w,]*\bcomments\b)/;
  const rawThreadReads = (text: string): string[] =>
    (text.match(GH_VIEW) ?? []).filter((command) => WANTS_COMMENTS.test(command));

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
    expect(rawThreadReads(sample)).toHaveLength(7);
  });

  it('no prompt file reads a thread with raw `gh issue view --comments` or `gh pr view --comments`', () => {
    expect(
      PROMPT_FILES.flatMap((file) => rawThreadReads(readPrompt(file)).map((command) => `${file}: ${command}`)),
      'Read an issue thread with `issue-thread <url> --json` and a PR thread with `comments <pr-url> --json` ' +
        "(add `--include-own` for the user's own comments): both fence every body (workflows/reference.md)",
    ).toEqual([]);
  });
});
