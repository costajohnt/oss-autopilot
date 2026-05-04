/**
 * Guidelines CLI commands (#867 PR 4).
 *
 * `guidelines view`        — read the per-repo guidelines file from the Gist.
 * `guidelines store`       — overwrite the per-repo guidelines file.
 * `guidelines reset`       — tombstone the file so subsequent reads return null.
 * `guidelines fetch-corpus` — pull raw PR comment bundles for the host's
 *                              extract-learnings prompt to consume.
 *
 * The CLI layer is pure data plumbing — extraction is the host's job.
 * Standalone-mode users see "not available" on store/reset/fetch-corpus
 * because per-repo guidelines require Gist persistence to be useful.
 */
import {
  getStateManager,
  requireGitHubToken,
  getOctokit,
  GuidelinesNotAvailableError,
  maybeCheckpoint,
} from '../core/index.js';
import { fetchPRCommentBundlesBatch, type PRCommentBundle } from '../core/pr-comments-fetcher.js';
import { warn } from '../core/logger.js';

const MODULE = 'guidelines';

const REPO_ID_PATTERN = /^[^/]+\/[^/]+$/;

const DEFAULT_FETCH_LIMIT = 5;
const MAX_FETCH_LIMIT = 10;

/**
 * Cliff at 12 months: PRs older than this are excluded from corpus fetches
 * (#867 design decision §5). Computed at call time, not module load.
 */
const RECENCY_CLIFF_MS = 365 * 24 * 60 * 60 * 1000;

export interface GuidelinesViewOutput {
  repo: string;
  /** Markdown content, or null when the repo has no guidelines stored. */
  content: string | null;
  /** UTF-8 byte size of `content`, or 0 when content is null. */
  byteSize: number;
  /** Whether a guidelines file exists for this repo. */
  exists: boolean;
  /** Where the guidelines would be persisted if a write happened now. */
  storageMode: 'gist' | 'local-unavailable';
}

export interface GuidelinesStoreOutput {
  repo: string;
  byteSize: number;
  stored: boolean;
}

export interface GuidelinesResetOutput {
  repo: string;
  /** True when an existing file was tombstoned, false when no file existed. */
  deleted: boolean;
}

export interface FetchCorpusOutput {
  repo: string;
  bundles: PRCommentBundle[];
  /** How many PRs were considered after recency + already-fetched filtering. */
  prCount: number;
  /** PRs skipped because `commentsFetchedAt` is already set (without --force). */
  skipped: number;
}

interface RepoOption {
  repo: string;
}

interface FetchCorpusOptions extends RepoOption {
  /** Cap on PRs to process. Defaults to 5; capped at 10 to bound prompt size. */
  limit?: number;
  /** Re-fetch even when commentsFetchedAt is already set. */
  forceRefetch?: boolean;
}

interface StoreOptions extends RepoOption {
  content: string;
}

function validateRepo(repo: string): void {
  if (!REPO_ID_PATTERN.test(repo)) {
    throw new Error(`Invalid repo identifier "${repo}". Expected "owner/repo" format.`);
  }
}

/** Read the per-repo guidelines for `repo`. Returns a `local-unavailable` envelope in non-Gist mode. */
export async function runGuidelinesView(options: RepoOption): Promise<GuidelinesViewOutput> {
  validateRepo(options.repo);
  const sm = getStateManager();
  const content = sm.getGuidelines(options.repo);
  return {
    repo: options.repo,
    content,
    byteSize: content === null ? 0 : Buffer.byteLength(content, 'utf-8'),
    exists: content !== null,
    storageMode: sm.isGuidelinesAvailable() ? 'gist' : 'local-unavailable',
  };
}

/**
 * Persist per-repo guidelines for `repo`. Throws when not in Gist mode or
 * when content exceeds the byte budget — the CLI surface relies on the
 * outputJson error envelope to surface that to the host cleanly.
 */
export async function runGuidelinesStore(options: StoreOptions): Promise<GuidelinesStoreOutput> {
  validateRepo(options.repo);
  if (!options.content || options.content.length === 0) {
    throw new Error('Cannot store empty content. Use `guidelines reset` to delete a guidelines file.');
  }
  const sm = getStateManager();
  // Throws GuidelinesNotAvailableError or GuidelinesTooLargeError on failure.
  sm.setGuidelines(options.repo, options.content);
  // Push to Gist — autoSave only writes the local state-cache mirror in Gist
  // mode, so without this checkpoint the change never propagates across
  // machines (#1200).
  await maybeCheckpoint(sm, MODULE);
  return {
    repo: options.repo,
    byteSize: Buffer.byteLength(options.content, 'utf-8'),
    stored: true,
  };
}

/** Tombstone the guidelines file for `repo`. */
export async function runGuidelinesReset(options: RepoOption): Promise<GuidelinesResetOutput> {
  validateRepo(options.repo);
  const sm = getStateManager();
  if (!sm.isGuidelinesAvailable()) {
    throw new GuidelinesNotAvailableError();
  }
  const existed = sm.getGuidelines(options.repo) !== null;
  if (existed) {
    sm.deleteGuidelines(options.repo);
    // Push to Gist — see runGuidelinesStore note (#1200).
    await maybeCheckpoint(sm, MODULE);
  }
  return { repo: options.repo, deleted: existed };
}

/**
 * Fetch raw PR comment bundles for the most recent merged/closed PRs in `repo`
 * that haven't already been processed. Returns a serializable corpus for the
 * host's extract-learnings prompt.
 *
 * Filters applied at the CLI layer (not the fetcher):
 * - Only PRs in the requested `repo`
 * - PRs older than 12 months are dropped (recency cliff)
 * - PRs with `commentsFetchedAt` already set are skipped unless `forceRefetch`
 * - Capped at `limit` (default 5, max 10)
 *
 * Stamps `commentsFetchedAt` on every PR that was successfully fetched.
 */
export async function runFetchCorpus(options: FetchCorpusOptions): Promise<FetchCorpusOutput> {
  validateRepo(options.repo);
  const limit = clampLimit(options.limit);
  const sm = getStateManager();

  const merged = sm.getMergedPRs() ?? [];
  const closed = sm.getClosedPRs() ?? [];
  const cutoffMs = Date.now() - RECENCY_CLIFF_MS;

  /** Treat both merged and closed-without-merge PRs as candidates. */
  const candidates: { url: string; timestamp: string; alreadyFetched: boolean }[] = [
    ...merged.map((pr) => ({ url: pr.url, timestamp: pr.mergedAt, alreadyFetched: !!pr.commentsFetchedAt })),
    ...closed.map((pr) => ({ url: pr.url, timestamp: pr.closedAt, alreadyFetched: !!pr.commentsFetchedAt })),
  ];

  const repoUrlPrefix = `https://github.com/${options.repo}/`;

  const eligible = candidates.filter((c) => {
    if (!c.url.startsWith(repoUrlPrefix)) return false;
    if (Date.parse(c.timestamp || '') < cutoffMs) return false;
    return true;
  });

  // Skipped count tracks ONLY the eligibility-passing PRs that were excluded
  // for already-fetched. PRs filtered by repo/recency aren't "skipped" — they
  // just don't apply to this repo or cutoff.
  const skipped = options.forceRefetch ? 0 : eligible.filter((c) => c.alreadyFetched).length;

  const toFetch = (options.forceRefetch ? eligible : eligible.filter((c) => !c.alreadyFetched))
    // Most-recent first so the host always sees the freshest signal in its corpus window.
    .sort((a, b) => Date.parse(b.timestamp || '') - Date.parse(a.timestamp || ''))
    .slice(0, limit);

  if (toFetch.length === 0) {
    return { repo: options.repo, bundles: [], prCount: 0, skipped };
  }

  const token = requireGitHubToken();
  const octokit = getOctokit(token);
  const username = sm.getState().config.githubUsername;
  if (!username) {
    warn(MODULE, 'githubUsername is not set; bot/own-comment filtering will be incomplete');
  }

  const bundles = await fetchPRCommentBundlesBatch(
    octokit,
    toFetch.map((c) => c.url),
    username,
  );

  // Stamp commentsFetchedAt on each PR we successfully fetched — the bundle
  // list mirrors the input order until paginateAll fan-out, so we mark on
  // a per-bundle basis to be safe.
  const now = new Date().toISOString();
  for (const bundle of bundles) {
    sm.markPRCommentsFetched(bundle.prUrl, now);
  }
  // Push commentsFetchedAt stamps to Gist so other machines don't re-fetch
  // the same PRs forever. autoSave only writes the local mirror in Gist
  // mode (#1200).
  if (bundles.length > 0) {
    await maybeCheckpoint(sm, MODULE);
  }

  return {
    repo: options.repo,
    bundles,
    prCount: bundles.length,
    skipped,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_FETCH_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_FETCH_LIMIT;
  return Math.min(limit, MAX_FETCH_LIMIT);
}
