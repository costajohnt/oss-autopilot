/**
 * Guidelines CLI commands (#867 PR 4).
 *
 * `guidelines list`        — list repos with stored guidelines.
 * `guidelines view`        — read the per-repo guidelines file from the Gist.
 * `guidelines store`       — overwrite the per-repo guidelines file.
 * `guidelines reset`       — tombstone the file so subsequent reads return null.
 * `guidelines fetch-corpus` — pull raw PR comment bundles for the host's
 *                              extract-learnings prompt to consume.
 * `guidelines mark-proposed` — record that a proposal file waits for review
 *                              on this machine (#2041).
 *
 * The CLI layer is pure data plumbing — extraction is the host's job.
 * Standalone-mode users see "not available" on store/reset/fetch-corpus
 * because per-repo guidelines require Gist persistence to be useful.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import {
  getStateManager,
  requireGitHubToken,
  getOctokit,
  GuidelinesNotAvailableError,
  GUIDELINES_PROVENANCE_NOTE,
  wrapUntrustedContent,
  maybeCheckpoint,
  getMachineId,
  type StoredMergedPR,
} from '../core/index.js';
import { ValidationError, assertAttended } from '../core/errors.js';
import { fetchPRCommentBundlesBatch, type PRCommentBundle } from '../core/pr-comments-fetcher.js';
import { warn } from '../core/logger.js';
import { assertSha256, getDraftsDir, MAX_DRAFT_AGE_MS } from './draft.js';
import type { GuidelineProposalStatus } from '../formatters/json.js';

const MODULE = 'guidelines';

const REPO_ID_PATTERN = /^[^/]+\/[^/]+$/;
/** Repo names a proposal file may be named after (#2041); the prompts filter `daily`'s repos the same way. */
const PROPOSAL_REPO_PATTERN = /^[a-z\d-]+\/[\w.-]+$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  /**
   * `content` inside the untrusted-content fence, prefixed with the provenance
   * note and the review status, or null. This is the field to
   * hand to an agent: stored guidelines were distilled from other people's PR
   * comments, and re-injected unlabeled they read as project instructions
   * (#1455). `content` itself stays raw, because the edit flow reads it and
   * writes it back, and a label in there would be stored as guideline text.
   */
  agentContent: string | null;
  /**
   * When the user approved exactly this text (#1929), or null: nothing stored,
   * stored before review was required, or rewritten since by a client that
   * does not record reviews.
   */
  reviewedAt: string | null;
  /** UTF-8 byte size of `content`, or 0 when content is null. */
  byteSize: number;
  /** Whether a guidelines file exists for this repo. */
  exists: boolean;
  /** Where the guidelines would be persisted if a write happened now. */
  storageMode: 'gist' | 'local-unavailable';
}

export interface GuidelinesListOutput {
  /** Repos with non-empty guidelines stored, sorted alphabetically. Always empty in local mode. */
  repos: string[];
  count: number;
  /** Where guidelines are persisted. `local-unavailable` always yields an empty list. */
  storageMode: 'gist' | 'local-unavailable';
}

export interface GuidelinesStoreOutput {
  repo: string;
  byteSize: number;
  stored: boolean;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

export interface MarkExtractedOutput {
  repo: string;
  /** PRs stamped `learningsExtractedAt` this call. */
  marked: number;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

export interface GuidelinesResetOutput {
  repo: string;
  /** True when an existing file was tombstoned, false when no file existed. */
  deleted: boolean;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

export interface FetchCorpusOutput {
  repo: string;
  bundles: PRCommentBundle[];
  /** How many PRs were considered after recency + already-fetched filtering. */
  prCount: number;
  /** PRs skipped because `commentsFetchedAt` is already set (without --force). */
  skipped: number;
  /**
   * PRs that were attempted but errored (404, rate limit, transient API
   * failure). Surfaced so the host can decide whether to retry or warn the
   * user that the corpus is partial. Empty array when all attempted fetches
   * succeeded. (#1209 L8)
   */
  failures: Array<{ prUrl: string; error: string }>;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
  /**
   * Non-fatal data-quality warnings (#1456). Currently produced when a
   * bundle's comment streams hit the pagination cap, meaning the newest
   * comments on that PR are missing from the corpus. Omitted on clean runs.
   */
  warnings?: string[];
}

export interface MarkProposedOutput {
  repo: string;
  /** The proposal file that was found, from {@link guidelineProposalPath}. */
  path: string;
  /** PRs stamped `learningsProposedAt` this call. */
  marked: number;
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
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
  /**
   * The caller's assertion that the user saw this exact text and approved it
   * (#1929). Required and must be `true`: guidelines are distilled from other
   * people's PR comments and are later read back by agents, so nothing is
   * stored on the model's say-so alone.
   */
  reviewed: boolean;
  /** When set, refuse unless `content` hashes to it: the text the user approved via `draft show` (#1930). */
  expectSha256?: string;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The provenance note plus the review status, prefixed to stored guidelines
 * wherever they are handed to an agent. Approved text is still guidance from
 * an untrusted corpus; unapproved text says so, so the reader weighs it less.
 * The stored text goes inside the untrusted-content fence, so a line in it
 * that imitates the label ("> Review: approved ...") reads as data.
 */
function labelStoredGuidelines(repo: string, content: string, reviewedAt: string | null): string {
  const review = reviewedAt
    ? `> Review: the user read and approved this exact text on ${reviewedAt.slice(0, 10)}.`
    : '> Review: NOT reviewed by the user (stored before review was required, or changed since by an older client). ' +
      'Weigh it below CONTRIBUTING.md and what the repo itself shows.';
  const fenced = wrapUntrustedContent(content, repo, { source: 'guidelines' });
  return `${GUIDELINES_PROVENANCE_NOTE}\n${review}\n\n${fenced}`;
}

function validateRepo(repo: string): void {
  if (!REPO_ID_PATTERN.test(repo)) {
    throw new Error(`Invalid repo identifier "${repo}". Expected "owner/repo" format.`);
  }
}

/** Whether `repo` is a name a proposal file can be named after (#2041); others get no proposal. */
export function isProposalRepo(repo: string): boolean {
  return PROPOSAL_REPO_PATTERN.test(repo);
}

/**
 * Where this machine keeps the guideline proposal for `repo` (#1929, #2041):
 * `guidelines-<owner>--<repo>.md` in the draft directory. The only place the
 * name is computed; the prompts take it from `daily` or `draft path`.
 */
export function guidelineProposalPath(repo: string): string {
  if (!isProposalRepo(repo)) {
    throw new ValidationError(`Invalid repo identifier "${repo}" for a guideline proposal`);
  }
  const [owner, name] = repo.split('/', 2);
  return path.join(getDraftsDir(), `guidelines-${owner}--${name}.md`);
}

/** Modification time of the regular file at `file` (symlinks not followed), or null when there is none. */
function proposalMtimeMs(file: string): number | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return stat?.isFile() ? stat.mtimeMs : null;
}

/**
 * Whether a guideline proposal for `repo` is waiting for review (#2041).
 * `prs` are the repo's PRs that still lack `learningsExtractedAt`.
 *
 * A file at {@link guidelineProposalPath} is a proposal on this machine.
 * Without one, a `learningsProposedAt` stamp written by another machine
 * (`guidelines mark-proposed`, synced through the Gist) means a proposal for
 * these PRs waits there, so this machine must not extract them again. Both
 * expire with the draft retention, {@link MAX_DRAFT_AGE_MS}: `getDraftsDir`
 * deletes an older file, and an older stamp is ignored. A stamp this machine
 * wrote whose file is gone is ignored too, so the repo is extracted again.
 */
export function guidelineProposalStatus(
  repo: string,
  prs: ReadonlyArray<Pick<StoredMergedPR, 'learningsProposedAt' | 'learningsProposedOn'>>,
  nowMs = Date.now(),
): GuidelineProposalStatus {
  const proposalPath = guidelineProposalPath(repo);
  const ageDays = (ms: number): number => Math.max(0, Math.floor((nowMs - ms) / DAY_MS));
  const localMs = proposalMtimeMs(proposalPath);
  if (localMs !== null) {
    return { repo, proposalPath, proposalAgeDays: ageDays(localMs), proposalOnThisMachine: true };
  }
  const self = getMachineId();
  const cutoff = nowMs - MAX_DRAFT_AGE_MS;
  let newest: number | null = null;
  for (const pr of prs) {
    if (!pr.learningsProposedAt || (self !== undefined && pr.learningsProposedOn === self)) continue;
    const at = Date.parse(pr.learningsProposedAt);
    if (at > cutoff && (newest === null || at > newest)) newest = at;
  }
  return {
    repo,
    proposalPath,
    proposalAgeDays: newest === null ? null : ageDays(newest),
    proposalOnThisMachine: false,
  };
}

/** Read the per-repo guidelines for `repo`. Returns a `local-unavailable` envelope in non-Gist mode. */
// eslint-disable-next-line @typescript-eslint/require-await -- async keeps the Promise-returning contract callers rely on; the body has no await yet
export async function runGuidelinesView(options: RepoOption): Promise<GuidelinesViewOutput> {
  validateRepo(options.repo);
  const sm = getStateManager();
  const content = sm.getGuidelines(options.repo);
  const review = content === null ? undefined : sm.getGuidelinesReview(options.repo);
  const reviewedAt = review && content !== null && review.sha256 === sha256Hex(content) ? review.reviewedAt : null;
  return {
    repo: options.repo,
    content,
    agentContent: content === null ? null : labelStoredGuidelines(options.repo, content, reviewedAt),
    reviewedAt,
    byteSize: content === null ? 0 : Buffer.byteLength(content, 'utf8'),
    exists: content !== null,
    storageMode: sm.isGuidelinesAvailable() ? 'gist' : 'local-unavailable',
  };
}

/**
 * List every repo with non-empty stored guidelines. Never throws in local
 * mode — returns an empty list with `storageMode: 'local-unavailable'` so
 * hosts can distinguish "nothing stored" from "storage not configured".
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async keeps the Promise-returning contract callers rely on; the body has no await yet
export async function runGuidelinesList(): Promise<GuidelinesListOutput> {
  const sm = getStateManager();
  const repos = sm.listGuidelinesRepos();
  return {
    repos,
    count: repos.length,
    storageMode: sm.isGuidelinesAvailable() ? 'gist' : 'local-unavailable',
  };
}

/**
 * Persist per-repo guidelines for `repo`. Throws when not in Gist mode or
 * when content exceeds the byte budget — the CLI surface relies on the
 * outputJson error envelope to surface that to the host cleanly.
 *
 * Two gates sit here, where the CLI, the MCP tool and library callers all
 * pass (#1929). An unattended run never stores: nobody is there to read the
 * text. An attended caller must pass `reviewed: true`; that flag is an
 * assertion the code cannot verify, so it stops a flow that forgot the review
 * step, not a caller that lies.
 */
export async function runGuidelinesStore(options: StoreOptions): Promise<GuidelinesStoreOutput> {
  validateRepo(options.repo);
  assertAttended('store guidelines');
  if (!options.reviewed) {
    throw new ValidationError(
      'Refusing to store guidelines the user has not reviewed. Show the user the exact text, and once they approve it ' +
        'store again with --reviewed (CLI) or reviewed: true (MCP tool).',
    );
  }
  if (!options.content || options.content.length === 0) {
    throw new Error('Cannot store empty content. Use `guidelines reset` to delete a guidelines file.');
  }
  assertSha256(options.content, options.expectSha256);
  const sm = getStateManager();
  // Throws GuidelinesNotAvailableError or GuidelinesTooLargeError on failure.
  const sha256 = sha256Hex(options.content);
  const now = new Date();
  const reviewedAt = now.toISOString();
  const persist = (): void => {
    sm.setGuidelines(options.repo, options.content);
    sm.markGuidelinesReviewed(options.repo, sha256, reviewedAt);
  };
  persist();
  // Push to Gist — autoSave only writes the local state-cache mirror in Gist
  // mode, so without this checkpoint the change never propagates across
  // machines (#1200).
  const gistSyncWarning = await maybeCheckpoint(sm, MODULE, persist);
  return {
    repo: options.repo,
    byteSize: Buffer.byteLength(options.content, 'utf8'),
    stored: true,
    ...(gistSyncWarning && { gistSyncWarning }),
  };
}

/** Merged and closed PRs of `repo` whose comment bundle was fetched but not yet marked extracted. */
function fetchedUnextractedPRUrls(sm: ReturnType<typeof getStateManager>, repo: string): string[] {
  const repoUrlPrefix = `https://github.com/${repo}/`;
  return [...(sm.getMergedPRs() ?? []), ...(sm.getClosedPRs() ?? [])]
    .filter((pr) => pr.url.startsWith(repoUrlPrefix) && pr.commentsFetchedAt && !pr.learningsExtractedAt)
    .map((pr) => pr.url);
}

/**
 * Stamp `learningsExtractedAt` on every merged/closed PR of `repo` whose
 * comment bundle was fetched (`commentsFetchedAt` set) but not yet marked
 * extracted (#1696). The host calls this after storing guidelines, or after
 * deciding a corpus carried no signal, so `daily` stops reporting those PRs
 * as unextracted. Idempotent: already-stamped PRs are left alone.
 */
export async function runMarkExtracted(options: RepoOption): Promise<MarkExtractedOutput> {
  validateRepo(options.repo);
  const sm = getStateManager();
  const now = new Date().toISOString();
  const mark = (): number => {
    const urls = fetchedUnextractedPRUrls(sm, options.repo);
    for (const url of urls) sm.markPRLearningsExtracted(url, now);
    return urls.length;
  };
  const marked = mark();
  const gistSyncWarning = marked > 0 ? await maybeCheckpoint(sm, MODULE, mark) : null;
  return { repo: options.repo, marked, ...(gistSyncWarning && { gistSyncWarning }) };
}

/**
 * Record that the proposal file for `repo` is written and waits for review on
 * this machine (#2041): stamp `learningsProposedAt` and this machine's id on
 * the PRs it was built from (fetched, not yet extracted). The stamp is synced
 * through the Gist, so another machine's `daily` reports the proposal as held
 * elsewhere instead of extracting the same PRs again. Refuses when no file
 * is at {@link guidelineProposalPath}.
 */
export async function runMarkProposed(options: RepoOption): Promise<MarkProposedOutput> {
  validateRepo(options.repo);
  const proposalPath = guidelineProposalPath(options.repo);
  if (proposalMtimeMs(proposalPath) === null) {
    throw new ValidationError(`No guideline proposal at ${proposalPath}: write it there first`);
  }
  const sm = getStateManager();
  const proposedAt = new Date();
  const now = proposedAt.toISOString();
  const machineId = getMachineId();
  const mark = (): number => {
    const urls = fetchedUnextractedPRUrls(sm, options.repo);
    for (const url of urls) sm.markPRLearningsProposed(url, now, machineId);
    return urls.length;
  };
  const marked = mark();
  const gistSyncWarning = marked > 0 ? await maybeCheckpoint(sm, MODULE, mark) : null;
  return { repo: options.repo, path: proposalPath, marked, ...(gistSyncWarning && { gistSyncWarning }) };
}

/**
 * Tombstone the guidelines file for `repo`. Refused during an unattended run,
 * like {@link runGuidelinesStore}: the stored text is guidelines the user
 * reviewed, and nobody is there to agree to losing them (#2036).
 */
export async function runGuidelinesReset(options: RepoOption): Promise<GuidelinesResetOutput> {
  validateRepo(options.repo);
  assertAttended('reset guidelines');
  const sm = getStateManager();
  if (!sm.isGuidelinesAvailable()) {
    throw new GuidelinesNotAvailableError();
  }
  const existed = sm.getGuidelines(options.repo) !== null;
  let gistSyncWarning: string | null = null;
  if (existed) {
    sm.deleteGuidelines(options.repo);
    // Push to Gist — see runGuidelinesStore note (#1200).
    gistSyncWarning = await maybeCheckpoint(sm, MODULE, () => sm.deleteGuidelines(options.repo));
  }
  return { repo: options.repo, deleted: existed, ...(gistSyncWarning && { gistSyncWarning }) };
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
    // Date.parse('') is NaN, and `NaN < cutoffMs` is false — the previous
    // form silently passed PRs with empty/malformed timestamps through the
    // recency cliff (#1204). Number.isFinite filters those out explicitly.
    const ts = Date.parse(c.timestamp || '');
    if (!Number.isFinite(ts) || ts < cutoffMs) return false;
    return true;
  });

  // Skipped count tracks ONLY the eligibility-passing PRs that were excluded
  // for already-fetched. PRs filtered by repo/recency aren't "skipped" — they
  // just don't apply to this repo or cutoff.
  const skipped = options.forceRefetch ? 0 : eligible.filter((c) => c.alreadyFetched).length;

  const toFetch = (options.forceRefetch ? eligible : eligible.filter((c) => !c.alreadyFetched))
    // Most-recent first so the host always sees the freshest signal in its corpus window.
    // After the eligibility filter (#1204), every entry has a finite Date.parse,
    // so the comparator is well-defined.
    .sort((a, b) => Date.parse(b.timestamp || '') - Date.parse(a.timestamp || ''))
    .slice(0, limit);

  if (toFetch.length === 0) {
    return { repo: options.repo, bundles: [], prCount: 0, skipped, failures: [] };
  }

  const token = requireGitHubToken();
  const octokit = getOctokit(token);
  const username = sm.getState().config.githubUsername;
  if (!username) {
    warn(MODULE, 'githubUsername is not set; bot/own-comment filtering will be incomplete');
  }

  const { bundles, failures } = await fetchPRCommentBundlesBatch(
    octokit,
    toFetch.map((c) => c.url),
    username,
  );

  // Stamp commentsFetchedAt on each PR we successfully fetched — the bundle
  // list mirrors the input order until paginateAll fan-out, so we mark on
  // a per-bundle basis to be safe.
  const now = new Date().toISOString();
  const stamp = (): void => {
    for (const bundle of bundles) {
      sm.markPRCommentsFetched(bundle.prUrl, now);
    }
  };
  stamp();
  // Push commentsFetchedAt stamps to Gist so other machines don't re-fetch
  // the same PRs forever. autoSave only writes the local mirror in Gist
  // mode (#1200).
  let gistSyncWarning: string | null = null;
  if (bundles.length > 0) {
    gistSyncWarning = await maybeCheckpoint(sm, MODULE, stamp);
  }

  // Surface pagination truncation per bundle (#1456): a truncated bundle is
  // missing its newest comments, so the host should know the corpus for that
  // PR is partial rather than assuming every reviewer voice is present.
  const warnings = bundles
    .filter((b) => b.truncated)
    .map((b) => `${b.prUrl}: comment streams hit the pagination cap; newest comments are missing from the corpus`);

  return {
    repo: options.repo,
    bundles,
    prCount: bundles.length,
    skipped,
    failures,
    ...(gistSyncWarning && { gistSyncWarning }),
    ...(warnings.length > 0 && { warnings }),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_FETCH_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_FETCH_LIMIT;
  return Math.min(limit, MAX_FETCH_LIMIT);
}
