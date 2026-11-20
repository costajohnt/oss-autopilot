/**
 * Stored path settings never reach shell text (#1934).
 *
 * `issueListPath` and `skippedIssuesPath` can be written by an agent over
 * MCP. A workflow that pastes one into a shell command runs whatever the
 * value contains, so the prompt files call commands that read the configured
 * path themselves (`skip-add`, `list-move-tier`, `list-mark-done`). This
 * fails when a `{issueListPath}`-style placeholder is put back inside a
 * fenced bash/sh/shell block.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROMPT_DIRS = ['commands', 'workflows', 'agents', 'skills'];
const PLACEHOLDER = /[{<](?:issueListPath|skippedIssuesPath)[}>]/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/;
const SHELL_LANGS = new Set(['bash', 'sh', 'shell']);

/** `file:line` for each path placeholder inside a fenced shell block. */
function shellPlaceholders(file: string, source: string): string[] {
  const hits: string[] = [];
  let fence: { marker: string; shell: boolean } | undefined;
  for (const [index, line] of source.split('\n').entries()) {
    const match = FENCE.exec(line);
    const closes = fence !== undefined && match !== null && line.trim().startsWith(fence.marker);
    if (fence?.shell && !closes && PLACEHOLDER.test(line)) hits.push(`${file}:${index + 1}`);
    const opened = match ? { marker: match[1], shell: SHELL_LANGS.has(match[2].toLowerCase()) } : undefined;
    fence = closes ? undefined : (fence ?? opened);
  }
  return hits;
}

function markdownFiles(dir: string): string[] {
  const root = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.md'))
    .map((rel) => path.join(dir, rel));
}

describe('stored path settings stay out of shell blocks (#1934)', () => {
  const files = PROMPT_DIRS.flatMap((dir) => markdownFiles(dir));

  it('finds the prompt files', () => {
    expect(files).toContain(path.join('commands', 'oss-search.md'));
  });

  it('no fenced bash/sh/shell block names issueListPath or skippedIssuesPath as a placeholder', () => {
    const hits = files.flatMap((file) => shellPlaceholders(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')));
    expect(
      hits,
      'A stored path pasted into shell text runs any $(...) it contains. Call a command that reads the configured path (skip-add, list-move-tier, list-mark-done) instead.',
    ).toEqual([]);
  });

  it.each([
    ['```bash\nSKIP_FILE="{skippedIssuesPath}"\n```', ['x.md:2']],
    ['```sh\nx --list-path <issueListPath>\n```', ['x.md:2']],
    ['```shell\n  --list-path "{issueListPath}"\n```', ['x.md:2']],
    ['```markdown\n{issueListPath}\n```', []],
    ['Set `{issueListPath}` in prose.\n```bash\necho ok\n```', []],
  ])('scanner: %j', (source, expected) => {
    expect(shellPlaceholders('x.md', source)).toEqual(expected);
  });
});
