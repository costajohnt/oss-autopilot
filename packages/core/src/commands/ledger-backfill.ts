/**
 * Backfill the outcome ledger (#1824 step 2).
 *
 * Entries written before the ledger carried `openedAt`, `issueUrl`, `pick`
 * and `closeReason` have none of them, so the eval report (#1825) would have
 * no history to calibrate against. This fills what can still be recovered:
 *
 * - `openedAt` and `issueUrl` (GitHub's `closingIssuesReferences`) via
 *   batched GraphQL; each answered PR is stamped `backfilledAt` so later
 *   runs only query new entries.
 * - `firstMaintainerResponseAt` (earliest maintainer comment or review, by
 *   the dormancy clock's rule), which feeds each repo's `avgResponseDays`.
 *   Entries backfilled before this field existed are re-queried once, gated
 *   by `responseBackfilledAt`; a PR whose scanned page held no response but
 *   was full stays unstamped and is re-queried.
 * - `closeReason` for closed-unmerged entries, from who closed the PR and its
 *   last comments (core/close-reason.ts).
 * - `pick` for entries with no vet-time snapshot, from the curated issue list
 *   and its sibling archives: an entry whose status line links the PR carries
 *   the vet score as `**Tier (N/10)**`.
 *
 * Only missing fields are filled (addMergedPRs/addClosedPRs never overwrite),
 * so the command is safe to re-run; the weekly eval job runs it first.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Octokit } from '@octokit/rest';
import { classifyCloseReason, classifySelfClose, type CloseContext } from '../core/close-reason.js';
import { errorMessage, isRateLimitOrAuthError } from '../core/errors.js';
import { getOctokit, requireGitHubToken, getStateManager, parseGitHubUrl } from '../core/index.js';
import { isGraphqlRateLimited } from '../core/pr-graphql.js';
import { getFirstMaintainerResponseAt } from '../core/review-analysis.js';
import { maybeCheckpoint } from '../core/state.js';
import type { PickSnapshot, StoredClosedPR, StoredMergedPR } from '../core/types.js';
import { detectIssueListPath } from './locate-issue-list.js';
import { findListEntryUrlByPrUrl } from './merge-loop.js';
import { parseIssueList } from './parse-list.js';

const BATCH_SIZE = 40;
/** The curated list keeps issues scored at least this (see /oss-search's score filter). */
const LIST_KEEP_SCORE = 6;

export interface LedgerBackfillOutput {
  /** Ledger PRs sent to GitHub because they had not been backfilled yet. */
  queried: number;
  /** Entries that gained each field in this run. */
  filled: { openedAt: number; issueUrl: number; closeReason: number; pick: number; firstMaintainerResponseAt: number };
  /** Curated-list files scanned for vet scores. */
  listFiles: string[];
  /** PRs GitHub returned nothing for this run; retried next run. */
  unresolved: number;
  /** Partial failures: failed batches, missing PRs by error type, unreadable list files. */
  warnings: string[];
  gistSyncWarning?: string;
}

interface Login {
  __typename?: string;
  login: string;
}

interface PRNode {
  createdAt?: string;
  author?: Login | null;
  closingIssuesReferences?: { nodes: Array<{ url: string } | null> };
  timelineItems?: { nodes: Array<{ actor?: Login | null } | null> };
  comments?: { nodes: Array<{ author?: Login | null; body: string } | null> };
  firstComments?: {
    nodes: Array<{ author?: Login | null; authorAssociation?: string | null; createdAt: string } | null>;
  };
  reviews?: { nodes: Array<{ author?: Login | null; submittedAt?: string | null } | null> };
}

/** Comments and reviews scanned per PR for the first maintainer response. */
const RESPONSE_SCAN = 10;

const PR_FIELDS = `
  createdAt
  author { __typename login }
  closingIssuesReferences(first: 1) { nodes { url } }
  timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { __typename login } } } }
  comments(last: 5) { nodes { author { __typename login } body } }
  firstComments: comments(first: ${RESPONSE_SCAN}) { nodes { author { __typename login } authorAssociation createdAt } }
  reviews(first: ${RESPONSE_SCAN}) { nodes { author { __typename login } submittedAt } }`;

/** GraphQL actor in the REST `user` shape; `type: 'Bot'` lets isBotAuthor drop bots without a `[bot]` suffix. */
const restUser = (a: Login | null | undefined) => (a ? { login: a.login, type: a.__typename } : null);

/**
 * Earliest maintainer comment or review, by the same rule as live enrichment
 * and the dormancy clock (isMaintainerEngagement). `truncated` is true when no
 * response was found but a full page came back, so a later one may exist:
 * the caller leaves the entry unstamped and it is re-queried next run.
 * ponytail: re-query instead of paging; page if many PRs sit there for good.
 */
function firstResponse(node: PRNode): { at?: string; isTruncated: boolean } {
  const commentNodes = node.firstComments?.nodes ?? [];
  const reviewNodes = node.reviews?.nodes ?? [];
  const comments = commentNodes
    .filter((c) => c !== null)
    .map((c) => ({ user: restUser(c.author), author_association: c.authorAssociation, created_at: c.createdAt }));
  const reviews = reviewNodes
    .filter((r) => r !== null)
    .map((r) => ({ user: restUser(r.author), submitted_at: r.submittedAt }));
  const at = node.author?.login ? getFirstMaintainerResponseAt(comments, reviews, node.author.login) : undefined;
  const isTruncated = !at && (commentNodes.length >= RESPONSE_SCAN || reviewNodes.length >= RESPONSE_SCAN);
  return { at, isTruncated };
}

/** First-response fields for a returned node; a truncated miss stays unstamped so it is re-queried. */
function responseFields(
  node: PRNode,
  now: string,
): { firstMaintainerResponseAt?: string; responseBackfilledAt?: string } {
  const { at, isTruncated } = firstResponse(node);
  return isTruncated ? {} : { firstMaintainerResponseAt: at, responseBackfilledAt: now };
}

/** True when the response lookup has never run for this entry (see responseBackfilledAt). */
const isMissingResponse = (e: StoredMergedPR | StoredClosedPR) =>
  !e.firstMaintainerResponseAt && !e.responseBackfilledAt;

type GraphqlError = { type?: string; path?: Array<string | number> };

/** One aliased GraphQL query for a batch of PR URLs. Fatal errors rethrow; null means the batch failed outright. */
async function fetchBatch(octokit: Octokit, urls: string[], warnings: string[]): Promise<Map<string, PRNode> | null> {
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
    const partial = (err as { data?: Response }).data;
    if (!partial) {
      warnings.push(`batch of ${urls.length} PRs failed: ${errorMessage(err)}`);
      return null;
    }
    // Some aliases failed (repo deleted, made private, SSO-gated): count by type.
    const types = new Map<string, number>();
    for (const e of (err as { errors?: GraphqlError[] }).errors ?? []) {
      const type = e.type ?? 'ERROR';
      types.set(type, (types.get(type) ?? 0) + 1);
    }
    warnings.push(`PRs GitHub did not return: ${[...types].map(([t, n]) => `${t} x${n}`).join(', ') || 'unknown'}`);
    data = partial;
  }
  const out = new Map<string, PRNode>();
  urls.forEach((url, i) => {
    const node = data[`p${i}`]?.pullRequest;
    if (node) out.set(url, node);
  });
  return out;
}

/** The curated list plus sibling files sharing its name stem (`<stem>-archive-*.md`). */
function readListFiles(issueListPath: string, warnings: string[]): Array<{ file: string; content: string }> {
  const dir = path.dirname(issueListPath);
  const stem = path.basename(issueListPath, '.md');
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(stem) && f.endsWith('.md'))
    .sort()
    .flatMap((f) => {
      const file = path.join(dir, f);
      try {
        return [{ file, content: fs.readFileSync(file, 'utf8') }];
      } catch (err) {
        warnings.push(`skipped list file ${file}: ${errorMessage(err)}`);
        return [];
      }
    });
}

/** The list's vet score for the issue whose entry links `prUrl`, if any. */
function listPick(lists: Array<{ content: string }>, prUrl: string): PickSnapshot | undefined {
  for (const { content } of lists) {
    const issueUrl = findListEntryUrlByPrUrl(content, prUrl);
    // The entry line's first URL can be a PR when an entry tracks one directly.
    if (!issueUrl?.includes('/issues/')) continue;
    const parsed = parseIssueList(content);
    const item = [...parsed.available, ...parsed.completed, ...parsed.blocked].find(
      (i) => i.url === issueUrl && i.score !== undefined,
    );
    if (item?.score !== undefined) {
      const recommendation = item.score >= LIST_KEEP_SCORE ? 'approve' : 'skip';
      return { issueUrl, grade: item.score, recommendation, source: 'list' };
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
    firstMaintainerResponseAt: entries.filter((e) => e.firstMaintainerResponseAt).length,
  };
}

export async function runLedgerBackfill(options: { issueListPath?: string } = {}): Promise<LedgerBackfillOutput> {
  const stateManager = getStateManager();
  const warnings: string[] = [];

  // Lists first: a bad path should fail before any GitHub work.
  if (options.issueListPath && !fs.existsSync(options.issueListPath)) {
    throw new Error(`Issue list not found: ${options.issueListPath}`);
  }
  const listPath = options.issueListPath ?? detectIssueListPath()?.path;
  if (!listPath) warnings.push('no curated issue list found; list vet scores were not imported');
  const lists = listPath ? readListFiles(listPath, warnings) : [];

  // 1. GitHub: openedAt, closing issue, close reason, first response, for
  // entries not yet backfilled, plus one-time re-fetches for fields added
  // later: selfCloseReason on self-closed entries, and firstMaintainerResponseAt
  // on entries that never had it looked up (responseBackfilledAt unset).
  const needsFetch = [
    ...stateManager.getMergedPRs().filter((e) => !e.backfilledAt || isMissingResponse(e)),
    ...stateManager
      .getClosedPRs()
      .filter(
        (e) => !e.backfilledAt || isMissingResponse(e) || (e.closeReason === 'self-closed' && !e.selfCloseReason),
      ),
  ].map((e) => e.url);
  const nodes = new Map<string, PRNode>();
  let fatal: Error | undefined;
  if (needsFetch.length > 0) {
    const octokit = getOctokit(requireGitHubToken());
    let failedBatches = 0;
    for (let i = 0; i < needsFetch.length; i += BATCH_SIZE) {
      try {
        const batch = await fetchBatch(octokit, needsFetch.slice(i, i + BATCH_SIZE), warnings);
        if (!batch) failedBatches++;
        for (const [url, node] of batch ?? []) nodes.set(url, node);
      } catch (err) {
        // Rate limit or auth: keep what earlier batches got, persist it, then rethrow.
        fatal = err as Error;
        break;
      }
    }
    if (!fatal && failedBatches === Math.ceil(needsFetch.length / BATCH_SIZE)) {
      throw new Error(`Every GitHub batch failed: ${warnings.join('; ')}`);
    }
  }

  // 2. Merge into fresh state: the GitHub phase can take a while, and upgrades
  // only fill missing fields, so re-applying them to reloaded state is safe.
  stateManager.reloadIfChanged();
  const merged = stateManager.getMergedPRs();
  const closed = stateManager.getClosedPRs();
  const before = countFilled([...merged, ...closed]);
  const snapshotFor = (issueUrl: string | undefined) =>
    issueUrl && stateManager.getPickSnapshots().some((p) => p.issueUrl.toLowerCase() === issueUrl.toLowerCase());
  const now = new Date().toISOString();

  const recovered = (entry: StoredMergedPR | StoredClosedPR) => {
    const node = nodes.get(entry.url);
    const fromList = entry.pick ? undefined : listPick(lists, entry.url);
    const issueUrl = node?.closingIssuesReferences?.nodes[0]?.url ?? entry.pick?.issueUrl ?? fromList?.issueUrl;
    // A vet-time snapshot (joined by addMergedPRs/addClosedPRs) beats the list
    // score, and a list score for a different issue than the PR closes is dropped.
    const pick = fromList && fromList.issueUrl === issueUrl && !snapshotFor(issueUrl) ? fromList : undefined;
    return {
      openedAt: node?.createdAt,
      issueUrl,
      pick,
      ...(node && { backfilledAt: now, ...responseFields(node, now) }),
    };
  };

  stateManager.batch(() => {
    stateManager.addMergedPRs(
      merged.map((e) => ({ url: e.url, title: e.title, mergedAt: e.mergedAt, ...recovered(e) })),
    );
    stateManager.addClosedPRs(
      closed.map((e) => {
        const node = nodes.get(e.url);
        const closedEvent = node?.timelineItems?.nodes.at(-1);
        // No closed event in the answer: leave the reason unset rather than guess.
        const context: CloseContext | undefined = closedEvent
          ? {
              author: node?.author?.login,
              closer: closedEvent.actor?.login,
              closerIsBot: closedEvent.actor?.__typename === 'Bot',
              comments: (node?.comments?.nodes ?? []).flatMap((c) =>
                c ? [{ author: c.author?.login, isBot: c.author?.__typename === 'Bot', body: c.body }] : [],
              ),
            }
          : undefined;
        const closeReason = context && classifyCloseReason(context);
        const selfCloseReason =
          context && (e.closeReason ?? closeReason) === 'self-closed' ? classifySelfClose(context) : undefined;
        return { url: e.url, title: e.title, closedAt: e.closedAt, ...recovered(e), closeReason, selfCloseReason };
      }),
    );
  });

  const after = countFilled([...stateManager.getMergedPRs(), ...stateManager.getClosedPRs()]);
  const gistSyncWarning = await maybeCheckpoint(stateManager, 'ledger-backfill');
  if (fatal) throw fatal;
  return {
    queried: needsFetch.length,
    filled: {
      openedAt: after.openedAt - before.openedAt,
      issueUrl: after.issueUrl - before.issueUrl,
      closeReason: after.closeReason - before.closeReason,
      pick: after.pick - before.pick,
      firstMaintainerResponseAt: after.firstMaintainerResponseAt - before.firstMaintainerResponseAt,
    },
    listFiles: lists.map((l) => l.file),
    unresolved: needsFetch.length - nodes.size,
    warnings,
    ...(gistSyncWarning && { gistSyncWarning }),
  };
}
