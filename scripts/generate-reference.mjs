#!/usr/bin/env node
/**
 * Auto-generate the agent integration table and the workflow index in
 * workflows/reference.md (#1289).
 *
 * Sources of truth:
 *   - Agent table: each agents/*.md frontmatter (`name`, `purpose`).
 *   - Workflow index: workflows/manifest.json (explicit curated list).
 *
 * The result is spliced between marker comments in reference.md:
 *   <!-- BEGIN AUTO:agent-table --> ... <!-- END AUTO:agent-table -->
 *   <!-- BEGIN AUTO:workflow-index --> ... <!-- END AUTO:workflow-index -->
 *
 * Run via: pnpm run generate:reference
 *
 * In CI, the same script runs followed by `git diff --exit-code workflows/reference.md`
 * — which fails if you changed an agent or the manifest without regenerating.
 *
 * Future scope (separate PR):
 *   - Auto-generate the CLI command reference (the much larger CLI Commands
 *     section, which would parse cli-registry.ts or consume `manifest --json`).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AGENTS_DIR = join(REPO_ROOT, 'agents');
const WORKFLOWS_DIR = join(REPO_ROOT, 'workflows');
const REFERENCE_PATH = join(WORKFLOWS_DIR, 'reference.md');
const WORKFLOW_MANIFEST_PATH = join(WORKFLOWS_DIR, 'manifest.json');

/**
 * Explicit ordering preserves the semantic grouping of the table (PR
 * lifecycle first, then issue lifecycle, then strategic) rather than
 * alphabetical. New agents must be added here AND get a `purpose:`
 * field — both are validated by this script.
 */
const AGENT_ORDER = [
  'pr-responder',
  'pr-health-checker',
  'pr-compliance-checker',
  'pre-commit-reviewer',
  'issue-scout',
  'repo-evaluator',
  'contribution-strategist',
];

const BEGIN_MARKER = '<!-- BEGIN AUTO:agent-table -->';
const END_MARKER = '<!-- END AUTO:agent-table -->';

/** Pull a value out of YAML frontmatter. Handles single-line scalar fields only. */
function readField(frontmatter, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const match = frontmatter.match(re);
  if (!match) return undefined;
  // Strip optional surrounding quotes; YAML allows `key: "value"` or `key: value`.
  return match[1].replace(/^["'](.*)["']$/, '$1').trim();
}

/** Parse the leading frontmatter block out of an agent file. */
function readFrontmatter(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const fenceMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fenceMatch) {
    throw new Error(`Could not find frontmatter in ${filePath}`);
  }
  return fenceMatch[1];
}

function buildAgentTable() {
  const files = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => join(AGENTS_DIR, f));

  const byName = new Map();
  for (const file of files) {
    const frontmatter = readFrontmatter(file);
    const name = readField(frontmatter, 'name');
    const purpose = readField(frontmatter, 'purpose');
    if (!name) {
      throw new Error(`agents/${file.split('/').pop()}: missing 'name' frontmatter field`);
    }
    if (!purpose) {
      throw new Error(
        `agents/${file.split('/').pop()}: missing 'purpose' frontmatter field — needed for the auto-generated agent table in workflows/reference.md (#1289). Add a one-line description.`,
      );
    }
    byName.set(name, purpose);
  }

  // Surface contract violations in either direction so adding a new agent
  // forces a deliberate update to AGENT_ORDER and removing one is loud.
  for (const name of AGENT_ORDER) {
    if (!byName.has(name)) {
      throw new Error(`AGENT_ORDER lists '${name}' but no matching agents/${name}.md was found`);
    }
  }
  for (const name of byName.keys()) {
    if (!AGENT_ORDER.includes(name)) {
      throw new Error(
        `agents/${name}.md exists but is not in AGENT_ORDER inside scripts/generate-reference.mjs — add it in the right slot or remove it.`,
      );
    }
  }

  const rows = ['| Agent | Purpose |', '|-------|---------|'];
  for (const name of AGENT_ORDER) {
    rows.push(`| \`${name}\` | ${byName.get(name)} |`);
  }
  return rows.join('\n');
}

function buildWorkflowIndex() {
  const raw = readFileSync(WORKFLOW_MANIFEST_PATH, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`workflows/manifest.json is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(manifest.workflows)) {
    throw new Error(`workflows/manifest.json must have a "workflows" array`);
  }

  const rows = ['| Workflow | Purpose |', '|---|---|'];
  for (const entry of manifest.workflows) {
    if (!entry.file || !entry.purpose) {
      throw new Error(
        `workflows/manifest.json: every entry needs both "file" and "purpose" keys (got ${JSON.stringify(entry)})`,
      );
    }
    const absPath = join(REPO_ROOT, entry.file);
    if (!existsSync(absPath)) {
      throw new Error(
        `workflows/manifest.json references "${entry.file}" but that file doesn't exist — remove the manifest entry or fix the path`,
      );
    }
    rows.push(`| \`${entry.file}\` | ${entry.purpose} |`);
  }
  return rows.join('\n');
}

function spliceBetweenMarkers(content, beginMarker, endMarker, replacement) {
  const beginIdx = content.indexOf(beginMarker);
  const endIdx = content.indexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(`Could not find both markers (${beginMarker} ... ${endMarker}) in reference.md`);
  }
  if (endIdx < beginIdx) {
    throw new Error(`END marker appears before BEGIN marker in reference.md`);
  }
  const before = content.slice(0, beginIdx + beginMarker.length);
  const after = content.slice(endIdx);
  return `${before}\n${replacement}\n${after}`;
}

function main() {
  const original = readFileSync(REFERENCE_PATH, 'utf8');
  let next = original;

  next = spliceBetweenMarkers(next, BEGIN_MARKER, END_MARKER, buildAgentTable());
  next = spliceBetweenMarkers(
    next,
    '<!-- BEGIN AUTO:workflow-index -->',
    '<!-- END AUTO:workflow-index -->',
    buildWorkflowIndex(),
  );

  if (next === original) {
    process.stdout.write('reference.md is already up to date.\n');
    return;
  }
  writeFileSync(REFERENCE_PATH, next, 'utf8');
  process.stdout.write('reference.md regenerated.\n');
}

main();
