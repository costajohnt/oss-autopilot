/**
 * Drift-detection test: plugin markdown that tells an agent to read
 * `data.<field>` from a CLI command's `--json` output must name a field that
 * command's Zod output schema actually has.
 *
 * Guards the class of bug where agents/pr-responder.md read
 * `data.repoScores[...]` from `status --json`, which never emitted it, so the
 * maintainer-relationship signal silently fell back to `first_pr`.
 *
 * ponytail: each `data.` reference is attributed to the nearest CLI invocation
 * on the same line or within LOOKBACK lines above it. Commands without a Zod
 * schema (goldens-only tier, MCP-only calls) are skipped. Not a parser; widen
 * the invocation regex if a doc starts invoking commands another way.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import { z, type ZodType } from 'zod';
import * as json from './formatters/json.js';

const ROOT = path.resolve(__dirname, '../../..');
const DOC_DIRS = ['agents', 'commands', 'workflows'];
const LOOKBACK = 30;

// startup is goldens-only, but its `daily` field is DailyOutput; check that much.
const STARTUP_SCHEMA = z.object({ daily: json.DailyOutputSchema }).catchall(z.unknown());

/** `<command>[ <subcommand>]` → the schema `executeAction` validates its `--json` output against. */
const SCHEMAS = new Map<string, ZodType>(
  Object.entries({
    status: json.StatusOutputSchema,
    strategy: json.StrategyOutputSchema,
    daily: json.DailyOutputSchema,
    search: json.SearchOutputSchema,
    features: json.FeaturesOutputSchema,
    doctor: json.DoctorOutputSchema,
    'skip-add': json.SkipAddOutputSchema,
    'list-move-tier': json.ListMoveTierOutputSchema,
    'list-mark-done': json.ListMarkDoneOutputSchema,
    'verify-issue': json.VerifyIssueOutputSchema,
    post: json.PostOutputSchema,
    claim: json.ClaimOutputSchema,
    init: json.InitOutputSchema,
    manifest: json.ManifestOutputSchema,
    checkSetup: json.CheckSetupOutputSchema,
    setup: json.SetupOutputSchema,
    config: json.ConfigCommandOutputSchema,
    move: json.MoveOutputSchema,
    'pr-template': json.PRTemplateOutputSchema,
    'repo-cap': json.RepoCapStatusSchema,
    'repo-vet': json.RepoVetOutputSchema,
    'compliance-score': json.ComplianceScoreOutputSchema,
    'parse-issue-list': json.ParseIssueListOutputSchema,
    'orphan-files': json.CheckIntegrationOutputSchema,
    'detect-formatters': json.DetectFormattersOutputSchema,
    'local-repos': json.LocalReposOutputSchema,
    'overnight report': json.OvernightReportOutputSchema,
    'overnight push-prep': json.OvernightPushPrepOutputSchema,
    startup: STARTUP_SCHEMA,
  }),
);

/** Docs that describe one command's output throughout, whatever else they invoke inline. */
const FILE_COMMAND: Record<string, string> = { 'workflows/startup-and-build.md': 'startup' };

// `cli.bundle.cjs" status --json` or an inline `` `status --json` `` mention.
const INVOCATION = new RegExp(
  [String.raw`cli\.bundle\.cjs\\?"?\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?`, '`([^`]*)--json`'].join('|'),
  'gi',
);
const COMMAND_WORD = /^[a-z][\w-]*$/i;
const REFERENCE = /\bdata\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]\s]*\])*/g;
const COLLECTION_MEMBERS = new Set(['length', 'find', 'map', 'filter', 'some', 'every', 'forEach']);

interface Def {
  type: string;
  innerType?: ZodType;
  in?: ZodType;
  getter?: () => ZodType;
  element?: ZodType;
  options?: ZodType[];
  shape?: Record<string, ZodType>;
  catchall?: ZodType;
}
const defOf = (s: ZodType) => (s as unknown as { def: Def }).def;
const WRAPPERS = new Set(['optional', 'nullable', 'default', 'readonly', 'catch', 'pipe', 'lazy']);
const OPEN_TYPES = new Set(['record', 'unknown', 'any']);

function unwrap(schema: ZodType): Def {
  let d = defOf(schema);
  while (WRAPPERS.has(d.type)) d = defOf(d.innerType ?? d.in ?? d.getter!());
  return d;
}

/** One path segment into `d`: the child schema, or a final verdict. */
function stepInto(d: Def, seg: string): ZodType | boolean {
  if (OPEN_TYPES.has(d.type)) return true;
  if (d.type === 'array') return COLLECTION_MEMBERS.has(seg) || (seg.startsWith('[') ? d.element! : false);
  if (d.type !== 'object') return seg === 'length';
  const next = Object.hasOwn(d.shape!, seg) ? d.shape![seg] : undefined;
  return next ?? (d.catchall !== undefined && defOf(d.catchall).type !== 'never');
}

function isResolvable(schema: ZodType, segments: string[]): boolean {
  let s = schema;
  for (const [i, seg] of segments.entries()) {
    const d = unwrap(s);
    if (d.type === 'union') return d.options!.some((o) => isResolvable(o, segments.slice(i)));
    const next = stepInto(d, seg);
    if (typeof next === 'boolean') return next;
    s = next;
  }
  return true;
}

interface Ref {
  file: string;
  line: number;
  command: string;
  path: string;
}

/** Schema keys of the CLI commands invoked on one line, in order. */
function invocationsOn(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(INVOCATION)) {
    const [cmd, sub] = m[1] ? [m[1], m[2]] : m[3].split(' ');
    if (COMMAND_WORD.test(cmd)) keys.push(sub && SCHEMAS.has(`${cmd} ${sub}`) ? `${cmd} ${sub}` : cmd);
  }
  return keys;
}

function refsIn(file: string): Ref[] {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const invocations = lines.map((text) => invocationsOn(text));
  const nearestCommand = (i: number): string | undefined => {
    for (let j = i; j >= Math.max(0, i - LOOKBACK); j--) {
      const cmd = invocations[j].at(-1);
      if (cmd) return cmd;
    }
    return undefined;
  };
  const refs: Ref[] = [];
  for (const [i, text] of lines.entries()) {
    for (const m of text.matchAll(REFERENCE)) {
      // `data.daily` is the plugin's name for startup's DailyOutput across every doc.
      const command = FILE_COMMAND[file] ?? (/^data\.daily\b/.test(m[0]) ? 'startup' : nearestCommand(i));
      if (command && SCHEMAS.has(command)) refs.push({ command, file, line: i + 1, path: m[0] });
    }
  }
  return refs;
}

function collectRefs(): Ref[] {
  return DOC_DIRS.flatMap((dir) =>
    fs
      .readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.md'))
      .flatMap((name) => refsIn(`${dir}/${name}`)),
  );
}

describe('plugin markdown `data.<field>` references match the --json output schemas', () => {
  const refs = collectRefs();

  it('finds the references it is meant to guard (non-vacuous)', () => {
    expect(refs.length).toBeGreaterThan(20);
    expect(refs).toContainEqual(
      expect.objectContaining({ file: 'agents/pr-responder.md', command: 'repo-cap', path: 'data.mergedPRCount' }),
    );
  });

  it('every referenced field exists in its command schema', () => {
    const broken = refs
      .filter((r) => {
        const segments = r.path
          .slice('data.'.length)
          .split(/\.|(?=\[)/)
          .filter(Boolean);
        return !isResolvable(SCHEMAS.get(r.command)!, segments);
      })
      .map((r) => `${r.file}:${r.line} reads \`${r.path}\` from \`${r.command} --json\`, which has no such field`);
    expect(broken, `Fix the doc or the command's output schema:\n${broken.join('\n')}`).toEqual([]);
  });
});
