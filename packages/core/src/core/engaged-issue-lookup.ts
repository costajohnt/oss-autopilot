/**
 * Batched GraphQL lookup of engaged issues the comment search missed (#1862).
 *
 * The REST path spent one `issues.get` per engaged issue to learn whether it
 * was still open and had changed since the engagement, and capped those
 * lookups in insertion order, so a user with more engaged issues than the cap
 * never had the tail looked at on any run. One aliased GraphQL query per
 * {@link ENGAGED_LOOKUP_BATCH_SIZE} issues answers the same question from
 * GitHub's separate GraphQL point bucket (a few points per query), so every
 * engaged issue is checked and the cap moves to the comment fetches, applied
 * only to the issues that actually changed.
 *
 * `issueOrPullRequest` rather than `issue`: a closing keyword can name a pull
 * request, and `issue(number:)` reports one as NOT_FOUND, the same as a deleted
 * issue. The union keeps the two apart, so a PR number is skipped quietly
 * instead of warned about as gone.
 *
 * Outcomes per issue: `found` (an issue node), `pull_request`, `gone` (a null
 * node, or a NOT_FOUND error in a partial response: deleted, transferred, or
 * now private), or `failed` (any other per-alias error, or a whole query that
 * failed for a reason other than rate limiting or auth; those rethrow).
 */

import type { Octokit } from '@octokit/rest';
import { errorMessage, isRateLimitOrAuthError } from './errors.js';
import { chunk, isGraphqlRateLimited } from './pr-graphql.js';

/** Issues per aliased GraphQL query. */
export const ENGAGED_LOOKUP_BATCH_SIZE = 50;

/** Labels requested per issue; the labels are display-only on the digest entry. */
const LABELS_CAP = 20;

/** One engaged issue to look up. */
export interface EngagedIssueRef {
  owner: string;
  repo: string;
  number: number;
  /** Canonical issue URL; the result map is keyed by it. */
  url: string;
}

/** The fields read off an issue node. */
export interface EngagedIssueNode {
  __typename: 'Issue';
  url: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  updatedAt: string;
  author: { login: string } | null;
  labels: { nodes: Array<{ name: string } | null> } | null;
}

type LookupNode = EngagedIssueNode | { __typename: 'PullRequest' } | null;

/** Shape of the aliased response: `{ i0: { issueOrPullRequest }, i1: null, ... }`. */
type LookupResponse = Record<string, { issueOrPullRequest: LookupNode } | null | undefined>;

export type EngagedIssueLookup =
  | { kind: 'found'; node: EngagedIssueNode }
  | { kind: 'pull_request' }
  | { kind: 'gone'; reason: string }
  | { kind: 'failed'; error: string };

interface GraphQLErrorEntry {
  type?: string;
  message?: string;
  path?: Array<string | number>;
}

const ISSUE_FIELDS = `
    __typename
    ... on Issue {
      url
      number
      title
      state
      updatedAt
      author { login }
      labels(first: ${LABELS_CAP}) { nodes { name } }
    }
  `;

/**
 * Build the aliased query for one batch. Owner, repo and number travel as
 * GraphQL variables, never interpolated into the query text.
 */
export function buildEngagedIssueQuery(refs: EngagedIssueRef[]): {
  query: string;
  variables: Record<string, string | number>;
} {
  const varDefs: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string | number> = {};

  for (const [i, ref] of refs.entries()) {
    varDefs.push(`$o${i}: String!, $r${i}: String!, $n${i}: Int!`);
    variables[`o${i}`] = ref.owner;
    variables[`r${i}`] = ref.repo;
    variables[`n${i}`] = ref.number;
    selections.push(
      `i${i}: repository(owner: $o${i}, name: $r${i}) {\n  issueOrPullRequest(number: $n${i}) {${ISSUE_FIELDS}}\n}`,
    );
  }

  const query = `query engagedIssues(${varDefs.join(', ')}) {\n${selections.join('\n')}\n}`;
  return { query, variables };
}

/** The errors of a partial response: keyed by the alias they point at, plus the ones without a path. */
function partitionErrors(err: unknown): {
  byAlias: Map<string, GraphQLErrorEntry[]>;
  unattributed: GraphQLErrorEntry[];
} {
  const byAlias = new Map<string, GraphQLErrorEntry[]>();
  const unattributed: GraphQLErrorEntry[] = [];
  const errors = (err as { errors?: Array<GraphQLErrorEntry | null> } | null)?.errors;
  if (!Array.isArray(errors)) return { byAlias, unattributed };
  for (const entry of errors) {
    if (!entry) continue;
    const alias = entry.path?.[0];
    if (typeof alias === 'string') {
      const list = byAlias.get(alias) ?? [];
      list.push(entry);
      byAlias.set(alias, list);
    } else {
      unattributed.push(entry);
    }
  }
  return { byAlias, unattributed };
}

interface ResolvedChunk {
  data: LookupResponse;
  byAlias: Map<string, GraphQLErrorEntry[]>;
  unattributed: GraphQLErrorEntry[];
}

type ChunkResult = ResolvedChunk | { failure: string };

/**
 * Run one batch. A partial-data error keeps the aliases that resolved and the
 * errors for the rest; rate-limit and auth errors (REST-style status or the
 * GraphQL-native `RATE_LIMITED`) rethrow; anything else fails the batch.
 */
async function runChunk(octokit: Octokit, refs: EngagedIssueRef[]): Promise<ChunkResult> {
  const { query, variables } = buildEngagedIssueQuery(refs);
  try {
    const data = await octokit.graphql<LookupResponse>(query, variables);
    return { data, byAlias: new Map(), unattributed: [] };
  } catch (err) {
    if (isRateLimitOrAuthError(err) || isGraphqlRateLimited(err)) throw err;
    const partial = (err as { data?: LookupResponse | null }).data;
    if (partial) return { data: partial, ...partitionErrors(err) };
    return { failure: errorMessage(err) };
  }
}

function describeEntry(entry: GraphQLErrorEntry): string {
  return `${entry.type ?? 'GraphQL'}: ${entry.message ?? 'error'}`;
}

/**
 * The outcome for one alias of a resolved batch. A null node is gone only
 * when GitHub said NOT_FOUND for it, or returned no error at all; a null
 * node in a response whose errors have no path (a server-side timeout, say)
 * is a failure, not a missing issue.
 */
function outcomeFor(chunk: ResolvedChunk, alias: string): EngagedIssueLookup {
  const node = chunk.data[alias]?.issueOrPullRequest;
  if (node) return node.__typename === 'PullRequest' ? { kind: 'pull_request' } : { kind: 'found', node };
  const errors = chunk.byAlias.get(alias) ?? [];
  const blocking = errors.find((e) => e.type !== 'NOT_FOUND');
  if (blocking) return { kind: 'failed', error: describeEntry(blocking) };
  const notFound = errors[0];
  if (notFound) return { kind: 'gone', reason: `NOT_FOUND: ${notFound.message ?? ''}`.trim() };
  const unattributed = chunk.unattributed[0];
  if (unattributed) return { kind: 'failed', error: describeEntry(unattributed) };
  return { kind: 'gone', reason: 'not returned by GitHub' };
}

/**
 * Look up every ref, one query per batch, sequentially (GitHub recommends
 * serial GraphQL requests). Returns an outcome per ref, keyed by URL.
 *
 * @throws The GraphQL error when it is a rate-limit or auth failure.
 */
export async function lookupEngagedIssues(
  octokit: Octokit,
  refs: EngagedIssueRef[],
): Promise<Map<string, EngagedIssueLookup>> {
  const outcomes = new Map<string, EngagedIssueLookup>();
  for (const batch of chunk(refs, ENGAGED_LOOKUP_BATCH_SIZE)) {
    const result = await runChunk(octokit, batch);
    for (const [i, ref] of batch.entries()) {
      if ('failure' in result) {
        outcomes.set(ref.url, { kind: 'failed', error: result.failure });
        continue;
      }
      outcomes.set(ref.url, outcomeFor(result, `i${i}`));
    }
  }
  return outcomes;
}
