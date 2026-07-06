/**
 * Batched GraphQL enrichment of open-PR details.
 *
 * The REST enrichment path (`PRMonitor.fetchPRDetails`) makes ~6 REST calls per
 * PR — `pulls.get`, paginated `issues.listComments`, `pulls.listReviews`,
 * paginated `pulls.listReviewComments`, CI status (combined-status + check-runs),
 * and a conditional `repos.getCommit`. For 30 open PRs that is ~180 core-quota
 * REST requests every daily run.
 *
 * `batchFetchPRDetails` collapses that into a handful of aliased GraphQL queries
 * (one per batch of {@link BATCH_SIZE} PRs) drawn from GitHub's SEPARATE GraphQL
 * point bucket (5000 points/hr; a multi-alias PR query costs ~1 point). Each PR's
 * data is mapped back into the same REST-equivalent shapes the shared
 * {@link PRSignals} pipeline consumes, so status determination is unchanged.
 *
 * Fallbacks (all route the affected PR back to the REST path):
 *  - GraphQL unavailable (no `.graphql` on the client) → every PR to REST.
 *  - A batch-level GraphQL error: fatal errors (401 / rate limit) rethrow; a
 *    partial-data error keeps the aliases that resolved and sends the rest to REST.
 *  - A PR that hit a `last:`/`first:` connection cap (comments > 100, reviews > 50,
 *    review threads > 50, or any thread's comments > 20) → REST, so pagination is
 *    complete and unresponded-comment detection stays correct.
 *  - A missing / inaccessible / malformed PR node → REST.
 */

import type { Octokit } from '@octokit/rest';
import { CIStatusResult } from './types.js';
import { computeCIStatus, type RawCheckRun, type RawCombinedStatus } from './ci-analysis.js';
import type { ReviewComment } from './review-analysis.js';
import type { AssemblyComment, AssemblyReview, CommitInfo } from './pr-assembly.js';
import { isRateLimitOrAuthError, errorMessage } from './errors.js';
import { warn } from './logger.js';

const MODULE = 'pr-graphql';

/** PRs per aliased GraphQL query. GitHub recommends modest batch sizes; ~10 keeps
 *  each query cheap (~1 point) and well under node/complexity limits. */
export const BATCH_SIZE = 10;

/** Connection page caps requested per PR. A PR exceeding any of these is sent to
 *  the REST path (which paginates fully) rather than silently truncated. */
export const COMMENTS_CAP = 100;
export const REVIEWS_CAP = 50;
export const REVIEW_THREADS_CAP = 50;
export const THREAD_COMMENTS_CAP = 20;
/** Status-check rollup contexts requested per commit. A PR with more distinct CI
 *  contexts than this is sent to REST so a failing check beyond the cap can't be
 *  silently dropped and mislabel the PR as passing. */
export const CI_CONTEXTS_CAP = 100;

/** A single PR to enrich. */
export interface PRRef {
  owner: string;
  repo: string;
  number: number;
  /** Original PR URL — used as the map key and to thread back into REST fallback. */
  url: string;
}

/**
 * Normalized PR data produced from a GraphQL node, in the REST-equivalent shapes
 * the {@link assembleFetchedPR} pipeline consumes. `commitInfo` is always present
 * (the batch fetches it for free) but is only consulted when the status logic
 * needs it.
 */
export interface NormalizedPRData {
  id: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  hasMergeConflict: boolean;
  headSha: string;
  comments: AssemblyComment[];
  reviews: AssemblyReview[];
  reviewComments: ReviewComment[];
  ciStatus: CIStatusResult;
  commitInfo: CommitInfo;
}

/** Outcome of a batched fetch: PRs resolved via GraphQL, plus the URLs that must
 *  fall back to the REST path (overflow, missing, or GraphQL-unavailable). */
export interface BatchPRResult {
  /** Keyed by {@link PRRef.url}. */
  resolved: Map<string, NormalizedPRData>;
  /** URLs the caller must enrich via the existing REST path. */
  restFallbackUrls: string[];
}

// ── GraphQL response node shapes ─────────────────────────────────────

interface GraphQLActor {
  login: string;
}

interface GraphQLCheckRunNode {
  __typename: 'CheckRun';
  name: string;
  conclusion: string | null;
  status: string | null;
  startedAt: string | null;
}

interface GraphQLStatusContextNode {
  __typename: 'StatusContext';
  context: string;
  state: string;
  description: string | null;
}

type GraphQLRollupContextNode = GraphQLCheckRunNode | GraphQLStatusContextNode | { __typename: string };

interface GraphQLCommitNode {
  oid: string;
  authoredDate: string | null;
  author: { user: GraphQLActor | null } | null;
  status: {
    state: string;
    contexts: Array<{ context: string; state: string; description: string | null }>;
  } | null;
  statusCheckRollup: {
    contexts: { totalCount: number; nodes: GraphQLRollupContextNode[] };
  } | null;
}

interface GraphQLPullRequestNode {
  databaseId: number | null;
  number: number;
  title: string;
  url: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  body: string | null;
  createdAt: string;
  updatedAt: string;
  comments: {
    totalCount: number;
    nodes: Array<{ author: GraphQLActor | null; body: string | null; createdAt: string }>;
  };
  reviews: {
    totalCount: number;
    nodes: Array<{
      databaseId: number | null;
      state: string;
      body: string | null;
      submittedAt: string | null;
      author: GraphQLActor | null;
    }>;
  };
  reviewThreads: {
    totalCount: number;
    nodes: Array<{
      comments: {
        totalCount: number;
        nodes: Array<{
          databaseId: number | null;
          body: string | null;
          createdAt: string;
          author: GraphQLActor | null;
          replyTo: { databaseId: number | null } | null;
          pullRequestReview: { databaseId: number | null } | null;
        }>;
      };
    }>;
  };
  commits: {
    nodes: Array<{ commit: GraphQLCommitNode }>;
  };
}

/** Shape of the aliased batch response: `{ pr0: { pullRequest }, pr1: { ... }, ... }`. */
type BatchResponse = Record<string, { pullRequest: GraphQLPullRequestNode | null } | null>;

const PR_FIELDS = `
  databaseId
  number
  title
  url
  mergeable
  body
  createdAt
  updatedAt
  comments(last: ${COMMENTS_CAP}) {
    totalCount
    nodes { author { login } body createdAt }
  }
  reviews(last: ${REVIEWS_CAP}) {
    totalCount
    nodes { databaseId state body submittedAt author { login } }
  }
  reviewThreads(last: ${REVIEW_THREADS_CAP}) {
    totalCount
    nodes {
      comments(last: ${THREAD_COMMENTS_CAP}) {
        totalCount
        nodes {
          databaseId
          body
          createdAt
          author { login }
          replyTo { databaseId }
          pullRequestReview { databaseId }
        }
      }
    }
  }
  commits(last: 1) {
    nodes {
      commit {
        oid
        authoredDate
        author { user { login } }
        status { state contexts { context state description } }
        statusCheckRollup {
          contexts(first: ${CI_CONTEXTS_CAP}) {
            totalCount
            nodes {
              __typename
              ... on CheckRun { name conclusion status startedAt }
              ... on StatusContext { context state description }
            }
          }
        }
      }
    }
  }
`;

/**
 * Build a parameterized aliased GraphQL query for a batch of PRs. Owner / repo /
 * number are passed as GraphQL variables — never string-interpolated into the
 * query body — so there is no injection surface.
 */
export function buildBatchQuery(refs: PRRef[]): { query: string; variables: Record<string, string | number> } {
  const varDefs: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string | number> = {};

  refs.forEach((ref, i) => {
    varDefs.push(`$o${i}: String!, $r${i}: String!, $n${i}: Int!`);
    variables[`o${i}`] = ref.owner;
    variables[`r${i}`] = ref.repo;
    variables[`n${i}`] = ref.number;
    selections.push(
      `pr${i}: repository(owner: $o${i}, name: $r${i}) {\n  pullRequest(number: $n${i}) {${PR_FIELDS}}\n}`,
    );
  });

  const query = `query batchPRDetails(${varDefs.join(', ')}) {\n${selections.join('\n')}\n}`;
  return { query, variables };
}

/** Map GraphQL `mergeable` enum to the REST `mergeConflict` boolean. */
function toMergeConflict(mergeable: GraphQLPullRequestNode['mergeable']): boolean {
  // CONFLICTING mirrors REST `mergeable === false` / `mergeable_state === 'dirty'`.
  // UNKNOWN mirrors REST `mergeable === null` (GitHub hasn't computed it yet) → not a conflict.
  return mergeable === 'CONFLICTING';
}

/** Map a GraphQL commit's rollup + legacy status into the CI result via the shared computer. */
function toCIStatus(commit: GraphQLCommitNode | undefined): CIStatusResult {
  // Check runs come from the rollup (mirrors `checks.listForRef`); only CheckRun
  // nodes are read here so StatusContexts aren't double-counted.
  const checkRuns: RawCheckRun[] = (commit?.statusCheckRollup?.contexts.nodes ?? [])
    .filter((n): n is GraphQLCheckRunNode => n.__typename === 'CheckRun')
    .map((n) => ({
      name: n.name,
      conclusion: n.conclusion ? n.conclusion.toLowerCase() : null,
      status: (n.status ?? '').toLowerCase(),
      started_at: n.startedAt ?? null,
    }));

  // Combined statuses come from the legacy status object (mirrors
  // `repos.getCombinedStatusForRef`). When absent, an empty statuses list is
  // equivalent to the REST empty-combined-status response (the `state` field is
  // ignored by `analyzeCombinedStatus` when there are no statuses).
  const combinedStatus: RawCombinedStatus = commit?.status
    ? {
        state: commit.status.state.toLowerCase(),
        statuses: commit.status.contexts.map((c) => ({
          state: c.state.toLowerCase(),
          context: c.context,
          description: c.description ?? null,
        })),
      }
    : { state: 'success', statuses: [] };

  return computeCIStatus(checkRuns, combinedStatus);
}

/** Discriminated outcome of normalizing one PR node. */
type NormalizeOutcome = { kind: 'ok'; data: NormalizedPRData } | { kind: 'overflow' } | { kind: 'missing' };

/**
 * Normalize a single GraphQL pull-request node into {@link NormalizedPRData},
 * or signal that it must fall back to REST (`overflow` — a connection cap was
 * hit; `missing` — the node was absent, inaccessible, or lacked a database id).
 */
export function normalizePRNode(node: GraphQLPullRequestNode | null | undefined): NormalizeOutcome {
  if (!node || node.databaseId == null) return { kind: 'missing' };

  // Any connection that hit its cap means data is incomplete — REST paginates fully.
  const rollupTotal = node.commits.nodes[0]?.commit?.statusCheckRollup?.contexts.totalCount ?? 0;
  if (
    node.comments.totalCount > COMMENTS_CAP ||
    node.reviews.totalCount > REVIEWS_CAP ||
    node.reviewThreads.totalCount > REVIEW_THREADS_CAP ||
    node.reviewThreads.nodes.some((t) => t.comments.totalCount > THREAD_COMMENTS_CAP) ||
    rollupTotal > CI_CONTEXTS_CAP
  ) {
    return { kind: 'overflow' };
  }

  const comments: AssemblyComment[] = node.comments.nodes.map((c) => ({
    user: c.author ? { login: c.author.login } : null,
    body: c.body,
    created_at: c.createdAt,
  }));

  // Drop PENDING reviews: REST `listReviews` only returns submitted reviews, and
  // a PENDING (draft) review has no `submittedAt`. Filtering keeps parity.
  const reviews: AssemblyReview[] = node.reviews.nodes
    .filter((r) => r.state !== 'PENDING')
    .map((r) => ({
      user: r.author ? { login: r.author.login } : null,
      body: r.body,
      submitted_at: r.submittedAt,
      state: r.state,
      id: r.databaseId ?? undefined,
    }));

  const reviewComments: ReviewComment[] = node.reviewThreads.nodes.flatMap((thread) =>
    thread.comments.nodes.map((c) => ({
      id: c.databaseId ?? 0,
      user: c.author ? { login: c.author.login } : null,
      body: c.body,
      created_at: c.createdAt,
      in_reply_to_id: c.replyTo?.databaseId ?? undefined,
      pull_request_review_id: c.pullRequestReview?.databaseId ?? null,
    })),
  );

  const commit = node.commits.nodes[0]?.commit;
  const commitInfo: CommitInfo = {
    date: commit?.authoredDate ?? undefined,
    author: commit?.author?.user?.login ?? undefined,
  };

  return {
    kind: 'ok',
    data: {
      id: node.databaseId,
      title: node.title,
      body: node.body ?? '',
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      hasMergeConflict: toMergeConflict(node.mergeable),
      headSha: commit?.oid ?? '',
      comments,
      reviews,
      reviewComments,
      ciStatus: toCIStatus(commit),
      commitInfo,
    },
  };
}

/** Split an array into fixed-size chunks. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Detect GitHub's primary GraphQL rate limit. Unlike a REST 429/403, an
 * exhausted GraphQL point budget arrives as an HTTP 200 with an
 * `errors[].type === 'RATE_LIMITED'` entry and NO numeric `.status`, so the
 * HTTP-status-based {@link isRateLimitOrAuthError} misses it. Treat it as fatal
 * (rethrow) rather than silently absorbing it into the REST fallback.
 */
export function isGraphqlRateLimited(err: unknown): boolean {
  const errors = (err as { errors?: Array<{ type?: string } | null> } | null)?.errors;
  return Array.isArray(errors) && errors.some((e) => e?.type === 'RATE_LIMITED');
}

/**
 * Run one batch's GraphQL query and return the raw alias→node response. On a
 * partial-data GraphQL error, returns the resolved aliases attached to the
 * error's `.data`. Fatal errors (401 / auth / rate limit — REST-style OR the
 * GraphQL-native `RATE_LIMITED`) rethrow; any other error returns `null` so the
 * whole batch falls back to REST.
 */
async function runBatch(octokit: Octokit, refs: PRRef[]): Promise<BatchResponse | null> {
  const { query, variables } = buildBatchQuery(refs);
  try {
    return await octokit.graphql<BatchResponse>(query, variables);
  } catch (err) {
    // Fatal signals must propagate BEFORE the partial-data fallback, so a
    // RATE_LIMITED error that arrives alongside partial data isn't swallowed.
    if (isRateLimitOrAuthError(err) || isGraphqlRateLimited(err)) throw err;
    // octokit's GraphqlResponseError attaches the resolved aliases to `.data`
    // when only some PRs in the batch errored (e.g. one repo went private).
    const partial = (err as { data?: BatchResponse }).data;
    if (partial) return partial;
    warn(MODULE, `GraphQL batch failed, falling back to REST: ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Enrich a set of PRs via batched GraphQL queries.
 *
 * Returns the PRs that resolved cleanly plus the URLs that must fall back to the
 * REST enrichment path. Batches run sequentially (GitHub recommends serial
 * requests); with ~3 queries for 30 PRs there is no concurrency benefit.
 */
export async function batchFetchPRDetails(octokit: Octokit, refs: PRRef[]): Promise<BatchPRResult> {
  const resolved = new Map<string, NormalizedPRData>();
  const restFallbackUrls: string[] = [];
  if (refs.length === 0) return { resolved, restFallbackUrls };

  // No GraphQL client available (e.g. a stubbed Octokit in tests) — everything
  // to REST. Guards against calling a non-function `.graphql`.
  if (typeof octokit.graphql !== 'function') {
    return { resolved, restFallbackUrls: refs.map((r) => r.url) };
  }

  for (const batch of chunk(refs, BATCH_SIZE)) {
    const data = await runBatch(octokit, batch);
    if (!data) {
      // Whole-batch failure — every PR in this batch falls back to REST.
      for (const ref of batch) restFallbackUrls.push(ref.url);
      continue;
    }

    batch.forEach((ref, i) => {
      // A malformed node (unexpected null sub-connection, etc.) routes just this
      // one PR to REST rather than rejecting the whole batch and discarding the
      // siblings that resolved cleanly.
      let outcome: NormalizeOutcome;
      try {
        outcome = normalizePRNode(data[`pr${i}`]?.pullRequest);
      } catch (err) {
        warn(MODULE, `Failed to normalize ${ref.url}, falling back to REST: ${errorMessage(err)}`);
        outcome = { kind: 'missing' };
      }
      if (outcome.kind === 'ok') {
        resolved.set(ref.url, outcome.data);
      } else {
        restFallbackUrls.push(ref.url);
      }
    });
  }

  return { resolved, restFallbackUrls };
}
