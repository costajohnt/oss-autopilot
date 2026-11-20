/**
 * `policy get|set|reset --repo owner/repo` (#1953): the per-repo contribution
 * policy record, and the vet-time write that fills it in.
 *
 * `get` only reads. `set` and `reset` refuse unattended runs: a record the
 * user sets is trusted over vet's reading of the repo docs, so nobody but the
 * user writes one. There is no MCP setter on purpose.
 */

import { getStateManager, maybeCheckpoint, warn, errorMessage } from '../core/index.js';
import { ValidationError, assertAttended } from '../core/errors.js';
import {
  AI_POLICIES,
  CLA_POLICIES,
  COMMIT_RULES,
  PR_GATES,
  effectivePolicy,
  fencePolicyText,
  isBlocklisted,
  isUnreadable,
  isUserReviewed,
  quote,
  isSamePolicy,
  storedPolicy,
  unknownFields,
  summarizePolicy,
  type AiPolicy,
  type ClaPolicy,
  type PrGate,
  type RepoPolicy,
  type RepoPolicySummary,
} from '../core/repo-policy.js';
import { validateRepoIdentifier } from './validation.js';

const MODULE = 'policy';

export interface PolicyGetOutput {
  repo: string;
  /** The policy that applies: the stored record with `config.aiPolicyBlocklist` read as a ban. Null when nothing is known. */
  policy:
    | (RepoPolicySummary & {
        updatedAt: string;
        /** True when the repo is in `config.aiPolicyBlocklist`; `policy set` cannot lift that ban. */
        blocklisted: boolean;
        /** The disclosure line the repo asks for, inside a `<github-content>` fence. */
        disclosureText?: string;
        /** `file: quoted line` per rule, inside a `<github-content>` fence. */
        sources?: string;
      })
    | null;
}

export interface PolicySetOptions {
  repo: string;
  aiPolicy?: string;
  disclosureText?: string;
  cla?: string;
  prGate?: string;
  /** Replaces the list; an empty string clears it. */
  commitRules?: string;
  /** 0 clears it. */
  maxOpenAiPRs?: number;
  /** Where the rule came from, e.g. a maintainer's comment; stored as a short quoted line. */
  source?: string;
}

export interface PolicyWriteOutput extends PolicyGetOutput {
  /**
   * How `--ai-policy` changed `config.aiPolicyBlocklist`: `added` for banned
   * (clients that predate policy records read only the blocklist), `removed`
   * for any other value (the blocklist always bans, so it would override the
   * record). Absent when the list did not change.
   */
  blocklistChange?: 'added' | 'removed';
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1370). */
  gistSyncWarning?: string;
}

export interface PolicyResetOutput {
  repo: string;
  deleted: boolean;
  gistSyncWarning?: string;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`Invalid ${flag} "${value}". Expected one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function parseCommitRules(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const rules = value
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  for (const rule of rules) oneOf(rule, COMMIT_RULES, '--commit-rules entry');
  return [...new Set(rules)];
}

function getOutput(repo: string): PolicyGetOutput {
  const state = getStateManager().getState();
  const policy = effectivePolicy(state, repo);
  if (!policy) return { repo, policy: null };
  return {
    repo,
    policy: {
      ...summarizePolicy(policy),
      updatedAt: policy.updatedAt,
      blocklisted: isBlocklisted(state, repo),
      ...fencePolicyText(repo, policy),
    },
  };
}

/** Read the policy that applies to `repo`. Untrusted text comes back fenced. */
export function runPolicyGet(options: { repo: string }): Promise<PolicyGetOutput> {
  validateRepoIdentifier(options.repo);
  return Promise.resolve(getOutput(options.repo));
}

function parseMax(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`Invalid --max-open-ai-prs "${value}". Expected a whole number (0 clears it).`);
  }
  return value;
}

/** The fields `options` sets; an absent flag leaves the stored value. */
function changes(options: PolicySetOptions): Partial<RepoPolicy> {
  const fields: Partial<RepoPolicy> = {
    aiPolicy: oneOf<AiPolicy>(options.aiPolicy, AI_POLICIES, '--ai-policy'),
    cla: oneOf<ClaPolicy>(options.cla, CLA_POLICIES, '--cla'),
    prGate: oneOf<PrGate>(options.prGate, PR_GATES, '--pr-gate'),
    commitRules: parseCommitRules(options.commitRules),
    maxOpenAiPRs: parseMax(options.maxOpenAiPRs),
    disclosureText: options.disclosureText === undefined ? undefined : quote(options.disclosureText),
  };
  const entries = Object.entries(fields as Record<string, unknown>);
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined));
}

function applySet(current: RepoPolicy, options: PolicySetOptions, now: string): RepoPolicy {
  const merged: RepoPolicy = { ...current, ...changes(options) };
  const source = options.source === undefined ? [] : [{ file: 'user', quotedLine: quote(options.source) }];
  const { maxOpenAiPRs, disclosureText, ...rest } = merged;
  return {
    ...rest,
    // 0 and '' clear these.
    ...(maxOpenAiPRs !== undefined && maxOpenAiPRs > 0 && { maxOpenAiPRs }),
    ...(disclosureText && { disclosureText }),
    source: [...source, ...current.source].slice(0, 10),
    reviewedByUser: true,
    updatedAt: now,
  };
}

/**
 * The stored record `set` merges over, or null. Refuses two cases where a merge
 * would record something the user never looked at: an entry this release
 * cannot parse (a newer release wrote it; merging would replace it with
 * defaults), and an unreviewed vet reading edited without `--ai-policy` (one
 * field edited would mark the heuristic's AI reading as reviewed).
 */
function storedRecordToEdit(
  state: ReturnType<ReturnType<typeof getStateManager>['getState']>,
  options: PolicySetOptions,
) {
  if (isUnreadable(state, options.repo)) {
    throw new ValidationError(
      `The stored policy for ${options.repo} was written by a newer oss-autopilot release and cannot be edited here. ` +
        `Update, or delete it with policy reset --repo ${options.repo} and set it again.`,
    );
  }
  const stored = storedPolicy(state, options.repo);
  if (stored && !stored.reviewedByUser && options.aiPolicy === undefined) {
    throw new ValidationError(
      `The stored policy for ${options.repo} was read from the repo docs (aiPolicy: ${stored.aiPolicy}) and nobody has ` +
        'reviewed it. Pass --ai-policy with the value you confirmed, so setting another field does not approve that reading.',
    );
  }
  return stored;
}

/**
 * Record the user's policy for `repo`, merged over what is stored. Refused
 * unattended, and the result is `reviewedByUser: true`, so vet never
 * overwrites it. It cannot lift a `config.aiPolicyBlocklist` ban.
 */
export async function runPolicySet(options: PolicySetOptions): Promise<PolicyWriteOutput> {
  validateRepoIdentifier(options.repo);
  assertAttended('set a repo contribution policy');
  const sm = getStateManager();
  const stored = storedRecordToEdit(sm.getState(), options);
  const date = new Date();
  const now = date.toISOString();
  const current = stored ?? {
    aiPolicy: 'unknown',
    cla: 'unknown',
    commitRules: [],
    prGate: 'unknown',
    source: [],
    reviewedByUser: true,
    updatedAt: now,
  };
  // Keep fields a newer release added; the known ones come from the merge.
  const next = { ...unknownFields(sm.getState(), options.repo), ...applySet(current, options, now) };
  const blocklist = blocklistUpdate(sm.getState().config.aiPolicyBlocklist ?? [], options);
  const persist = (): void => {
    sm.setRepoPolicy(options.repo, next);
    if (blocklist) sm.updateConfig({ aiPolicyBlocklist: blocklist.list });
  };
  persist();
  const gistSyncWarning = await maybeCheckpoint(sm, MODULE, persist);
  return {
    ...getOutput(options.repo),
    ...(blocklist && { blocklistChange: blocklist.change }),
    ...(gistSyncWarning && { gistSyncWarning }),
  };
}

/**
 * The blocklist after `--ai-policy`, or null when it does not change. Appends
 * to the stored list (never replaces it); removal is case-insensitive. Without
 * `--ai-policy` the list is left alone, and so does `policy reset`.
 */
function blocklistUpdate(
  current: readonly string[],
  options: PolicySetOptions,
): { list: string[]; change: 'added' | 'removed' } | null {
  if (options.aiPolicy === undefined) return null;
  const lower = options.repo.toLowerCase();
  const isListed = current.some((r) => r.toLowerCase() === lower);
  if (options.aiPolicy === 'banned') return isListed ? null : { list: [...current, options.repo], change: 'added' };
  if (!isListed) return null;
  return { list: current.filter((r) => r.toLowerCase() !== lower), change: 'removed' };
}

/**
 * Delete the stored record for `repo`. Refused unattended: deleting a ban the
 * user recorded relaxes it. `config.aiPolicyBlocklist` is left as is.
 */
export async function runPolicyReset(options: { repo: string }): Promise<PolicyResetOutput> {
  validateRepoIdentifier(options.repo);
  assertAttended('reset a repo contribution policy');
  const sm = getStateManager();
  const hasRecord = sm.getState().repoPolicies?.[options.repo.toLowerCase()] !== undefined;
  if (!hasRecord) return { repo: options.repo, deleted: false };
  sm.setRepoPolicy(options.repo, null);
  const gistSyncWarning = await maybeCheckpoint(sm, MODULE, () => sm.setRepoPolicy(options.repo, null));
  return { repo: options.repo, deleted: true, ...(gistSyncWarning && { gistSyncWarning }) };
}

/**
 * Store what vet read from the repo docs, unreviewed. Never replaces a record
 * the user set, and skips the write when nothing changed. A failure is logged,
 * never thrown: recording the policy must not fail the vet.
 */
export async function recordVetPolicy(repo: string, derived: RepoPolicy): Promise<void> {
  await recordVetPolicies([{ repo, policy: derived }]);
}

/**
 * {@link recordVetPolicy} for several repos, with one Gist checkpoint. With
 * `fillOnly` (vet-list, which reads only scout's CONTRIBUTING text) a stored
 * record is replaced only by a ban: a narrower reading must not overwrite one
 * vet took from more docs.
 */
export async function recordVetPolicies(
  readings: ReadonlyArray<{ repo: string; policy: RepoPolicy }>,
  options: { fillOnly?: boolean } = {},
): Promise<void> {
  try {
    await writeVetPolicies(readings, options.fillOnly === true);
  } catch (error) {
    const repos = readings.map((r) => r.repo).join(', ');
    warn(MODULE, `Could not record the contribution policy for ${repos}: ${errorMessage(error)}`);
  }
}

async function writeVetPolicies(
  readings: ReadonlyArray<{ repo: string; policy: RepoPolicy }>,
  isFillOnly: boolean,
): Promise<void> {
  const sm = getStateManager();
  sm.reloadIfChanged();
  const writes = readings.filter(({ repo, policy }) => shouldWrite(repo, policy, isFillOnly));
  if (writes.length === 0) return;
  const write = (): void => {
    for (const { repo, policy } of writes) {
      if (!isUserReviewed(sm.getState(), repo)) sm.setRepoPolicy(repo, policy);
    }
  };
  write();
  await maybeCheckpoint(sm, MODULE, write);
}

function shouldWrite(repo: string, derived: RepoPolicy, isFillOnly: boolean): boolean {
  const state = getStateManager().getState();
  // Never replace the user's record or one a newer release wrote.
  if (isUserReviewed(state, repo) || isUnreadable(state, repo)) return false;
  const stored = storedPolicy(state, repo);
  if (!stored) return true;
  if (isSamePolicy(stored, derived)) return false;
  // A recorded ban stays until the user says otherwise: a later reading that misses it does not lift it.
  if (stored.aiPolicy === 'banned') return derived.aiPolicy === 'banned';
  return !isFillOnly || derived.aiPolicy === 'banned';
}
