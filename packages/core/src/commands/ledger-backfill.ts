/**
 * Backfill the outcome ledger (#1824 step 2).
 *
 * Entries written before the ledger carried `openedAt`, `issueUrl`, `pick`
 * and `closeReason` have none of them, so the eval report (#1825) would have
 * no history to calibrate against. This fills what can still be recovered:
 *
 * - `openedAt` and `issueUrl` (GitHub's `closingIssuesReferences`) for every
 *   entry missing them, in batched GraphQL queries.
 * - `closeReason` for closed-unmerged entries, from who closed the PR and its
 *   last comments (core/close-reason.ts).
 * - `pick` from the curated issue list and its sibling archives: an entry
 *   whose status line links the PR carries the vet score as `**Tier (N/10)**`.
 *
 * Only missing fields are filled (addMergedPRs/addClosedPRs never overwrite),
 * so the command is safe to re-run; the weekly eval job runs it first so new
 * closures get a reason.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Octokit } from '@octokit/rest';
import { classifyCloseReason } from '../core/close-reason.js';
import { errorMessage, isRateLimitOrAuthError } from '../core/errors.js';
import { getOctokit, requireGitHubToken, getStateManager, parseGitHubUrl } from '../core/index.js';
import { warn } from '../core/logger.js';
import { isGraphqlRateLimited } from '../core/pr-graphql.js';
import { maybeCheckpoint } from '../core/state.js';
import type { PickSnapshot, StoredClosedPR, StoredMergedPR } from '../core/types.js';
import { detectIssueListPath } from './locate-issue-list.js';
import { findListEntryUrlByPrUrl } from './merge-loop.js';
import { parseIssueList } from './parse-list.js';

const MODULE = 'ledger-backfill';
const BATCH_SIZE = 40;

export interface LedgerBackfillOutput {
  /** Ledger PRs sent to GitHub because a recoverable field was missing. */
  queried: number;
  /** Entries that gained each field in this run. */
  filled: { openedAt: number; issueUrl: number; closeReason: number; pick: number };
  /** Curated-list files scanned for vet scores. */
  listFiles: string[];
  /** PRs GitHub returned nothing for (deleted repo, private, transient error). */
  unresolved: number;
  gistSyncWarning?: string;
}

interface PRNode {
  createdAt?: string;
  author?: { login: string } | null;
  closingIssuesReferences?: { nodes: Array<{ url: string } | null> };
  timelineItems?: { nodes: Array<{ actor?: { login: string } | null } | null> };
  comments?: { nodes: Array<{ author?: { login: string } | null; body: string } | null> };
}

const PR_FIELDS = `
  createdAt
  author { login }
  closingIssuesReferences(first: 1) { nodes { url } }
  timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { login } } } }
  comments(last: 5) { nodes { author { login } body } }`;

/** One aliased GraphQL query for a batch of PR URLs. */
async function fetchBatch(octokit: Octokit, urls: string[]): Promise<Map<string, PRNode>> {
  const varDefs: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string | number> = {};
  urls.forEach((url, i) => {
    const ref = parseGitHubUrl(url);
    if (!ref) return;
    varDefs.push(`$o${i}: String!, $r${i}: String!, $n${i}: Int!`);
    Object.assign(variables, { [`o${i}`]: ref.owner, [`r${i}`]: ref.repo, [`n${i}`]: ref.number });
    selections.push(`p${i}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) {${PR_FIELDS}} }`);
  });
  if (selections.length === 0) return new Map();
  const query = `query ledgerBackfill(${varDefs.join(', ')}) {\n${selections.join('\n')}\n}`;

  type Response = Record<string, { pullRequest: PRNode | null } | null>;
  let data: Response;
  try {
    data = await octokit.graphql<Response>(query, variables);
  } catch (err) {
    if (isRateLimitOrAuthError(err) || isGraphqlRateLimited(err)) throw err;
    // Partial data: some aliases failed (repo deleted or made private).
    const partial = (err as { data?: Response }).data;
    if (!partial) {
      warn(MODULE, `GraphQL batch failed: ${errorMessage(err)}`);
      return new Map();
    }
    data = partial;
  }
  const out = new Map<string, PRNode>();
  urls.forEach((url, i) => {
    const node = data[`p${i}`]?.pullRequest;
    if (node) out.set(url, node);
  });
  return out;
}

/** The curated list plus its `potential-issue-list*.md`-style sibling archives. */
function findListFiles(issueListPath: string | undefined): string[] {
  if (!issueListPath || !fs.existsSync(issueListPath)) return [];
  const dir = path.dirname(issueListPath);
  const stem = path.basename(issueListPath, '.md');
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(stem) && f.endsWith('.md'))
    .map((f) => path.join(dir, f))
    .sort();
}

/** The list's vet score for the issue whose entry links `prUrl`, if any. */
function listPick(lists: Array<{ content: string; capturedAt: string }>, prUrl: string): PickSnapshot | undefined {
  for (const { content, capturedAt } of lists) {
    const issueUrl = findListEntryUrlByPrUrl(content, prUrl);
    if (!issueUrl) continue;
    const parsed = parseIssueList(content);
    const item = [...parsed.available, ...parsed.completed, ...parsed.blocked].find(
      (i) => i.url === issueUrl && i.score !== undefined,
    );
    if (item?.score !== undefined) {
      return { issueUrl, grade: item.score, recommendation: item.tier, source: 'list', capturedAt };
    }
  }
  return undefined;
}

function countFilled(entries: Array<StoredMergedPR | StoredClosedPR>) {
  return {
    openedAt: entries.filter((e) => e.openedAt).length,
    issueUrl: entries.filter((e) => e.issueUrl).length,
    closeReason: entries.filter((e) => 'closeReason' in e && e.closeReason).length,
    pick: entries.filter((e) => e.pick).length,
  };
}

export async function runLedgerBackfill(options: { issueListPath?: string } = {}): Promise<LedgerBackfillOutput> {
  const stateManager = getStateManager();
  const merged = stateManager.getMergedPRs();
  const closed = stateManager.getClosedPRs();
  const before = countFilled([...merged, ...closed]);

  // 1. GitHub: openedAt, closing issue, close reason.
  const needsFetch = [
    ...merged.filter((e) => !e.openedAt || !e.issueUrl),
    ...closed.filter((e) => !e.openedAt || !e.issueUrl || !e.closeReason),
  ].map((e) => e.url);
  const nodes = new Map<string, PRNode>();
  if (needsFetch.length > 0) {
    const octokit = getOctokit(requireGitHubToken());
    for (let i = 0; i < needsFetch.length; i += BATCH_SIZE) {
      for (const [url, node] of await fetchBatch(octokit, needsFetch.slice(i, i + BATCH_SIZE))) {
        nodes.set(url, node);
      }
    }
  }

  // 2. Curated list scores for entries with no prediction yet.
  const listFiles = findListFiles(options.issueListPath ?? detectIssueListPath()?.path);
  const lists = listFiles.map((f) => ({
    content: fs.readFileSync(f, 'utf8'),
    capturedAt: fs.statSync(f).mtime.toISOString(),
  }));

  const recovered = (entry: StoredMergedPR | StoredClosedPR) => {
    const node = nodes.get(entry.url);
    const pick = entry.pick ? undefined : listPick(lists, entry.url);
    return {
      openedAt: node?.createdAt,
      issueUrl: node?.closingIssuesReferences?.nodes[0]?.url ?? pick?.issueUrl,
      pick,
    };
  };

  stateManager.addMergedPRs(merged.map((e) => ({ url: e.url, title: e.title, mergedAt: e.mergedAt, ...recovered(e) })));
  stateManager.addClosedPRs(
    closed.map((e) => {
      const node = nodes.get(e.url);
      const closeReason = node
        ? classifyCloseReason({
            author: node.author?.login,
            closer: node.timelineItems?.nodes.at(-1)?.actor?.login,
            comments: (node.comments?.nodes ?? []).flatMap((c) =>
              c ? [{ author: c.author?.login, body: c.body }] : [],
            ),
          })
        : undefined;
      return { url: e.url, title: e.title, closedAt: e.closedAt, ...recovered(e), closeReason };
    }),
  );

  const after = countFilled([...stateManager.getMergedPRs(), ...stateManager.getClosedPRs()]);
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);
  return {
    queried: needsFetch.length,
    filled: {
      openedAt: after.openedAt - before.openedAt,
      issueUrl: after.issueUrl - before.issueUrl,
      closeReason: after.closeReason - before.closeReason,
      pick: after.pick - before.pick,
    },
    listFiles,
    unresolved: needsFetch.length - nodes.size,
    ...(gistSyncWarning && { gistSyncWarning }),
  };
}
