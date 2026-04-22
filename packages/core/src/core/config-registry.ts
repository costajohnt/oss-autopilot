/**
 * Single source of truth for user-configurable state.json config keys.
 *
 * Keys fall into two CLI surfaces:
 *   - `oss-autopilot setup --set key=value` — direct scalar / list-replace sets
 *   - `oss-autopilot config <key> <value>`  — list mutators (add-/remove-) and aliases
 *
 * A key may be settable via one, the other, or both. `auto` means the field is
 * populated by internal code (e.g. starredRepos is fetched from GitHub), never
 * by a user command — it's listed here so `scout-bridge.ts` reads are auditable.
 *
 * When adding a new user-configurable state.json field:
 *   1. Add the field to `AgentConfigSchema` (state-schema.ts).
 *   2. Add an entry here.
 *   3. Wire the handler in `commands/setup.ts` and/or `commands/config.ts`.
 *   4. The registry test (`config-registry.test.ts`) asserts both commands
 *      handle every non-`auto` key.
 */

export type SettableVia = 'setup' | 'config' | 'both' | 'auto';

export interface ConfigKeyDef {
  /** The key as users type it (may differ from the underlying state field, e.g. `dormantDays` → `dormantThresholdDays`). */
  key: string;
  /** One-line human description — shown by `config --list-keys`. */
  description: string;
  /** Which CLI surface accepts this key. */
  settableVia: SettableVia;
  /** Short hint for the expected value shape (e.g. `"number"`, `"owner/repo"`, `"comma-separated list"`). */
  valueHint: string;
}

export const CONFIG_KEY_REGISTRY: readonly ConfigKeyDef[] = [
  // ── Identity ─────────────────────────────────────────────────────────
  {
    key: 'username',
    description: 'Your GitHub username.',
    settableVia: 'both',
    valueHint: 'string',
  },

  // ── Capacity / dormancy ──────────────────────────────────────────────
  {
    key: 'maxActivePRs',
    description: 'Soft cap on how many active PRs you want to juggle at once.',
    settableVia: 'setup',
    valueHint: 'positive integer',
  },
  {
    key: 'dormantDays',
    description: 'Alias for dormantThresholdDays: days of inactivity before a PR is considered dormant.',
    settableVia: 'setup',
    valueHint: 'positive integer',
  },
  {
    key: 'approachingDays',
    description: 'Alias for approachingDormantDays: days before dormancy threshold at which to warn.',
    settableVia: 'setup',
    valueHint: 'positive integer',
  },

  // ── Issue discovery ──────────────────────────────────────────────────
  {
    key: 'languages',
    description: 'Programming languages to filter issue discovery by (whole-list replace).',
    settableVia: 'setup',
    valueHint: 'comma-separated list',
  },
  {
    key: 'labels',
    description: 'Issue labels to search for (whole-list replace).',
    settableVia: 'setup',
    valueHint: 'comma-separated list',
  },
  {
    key: 'scope',
    description: 'Issue complexity scope(s) — beginner, intermediate, advanced.',
    settableVia: 'setup',
    valueHint: 'comma-separated list of: beginner,intermediate,advanced',
  },
  {
    key: 'minStars',
    description: 'Minimum stargazers required for a repo to surface during discovery.',
    settableVia: 'setup',
    valueHint: 'non-negative integer',
  },
  {
    key: 'includeDocIssues',
    description: 'Whether documentation-only issues should appear in discovery.',
    settableVia: 'setup',
    valueHint: 'true|false',
  },
  {
    key: 'maxIssueAgeDays',
    description: 'Maximum age (in days) for an issue to be considered in discovery.',
    settableVia: 'setup',
    valueHint: 'positive integer',
  },
  {
    key: 'minRepoScoreThreshold',
    description: 'Minimum repo maintainer-health score required for discovery (0–10).',
    settableVia: 'setup',
    valueHint: 'non-negative integer',
  },
  {
    key: 'projectCategories',
    description: 'Project categories to prioritize (whole-list replace).',
    settableVia: 'setup',
    valueHint: 'comma-separated list of: nonprofit,devtools,infrastructure,web-frameworks,data-ml,education',
  },
  {
    key: 'preferredOrgs',
    description: 'GitHub orgs to prioritize during discovery (whole-list replace).',
    settableVia: 'setup',
    valueHint: 'comma-separated list',
  },
  {
    key: 'aiPolicyBlocklist',
    description: 'Repos (owner/repo) with anti-AI contribution policies to block from discovery.',
    settableVia: 'setup',
    valueHint: 'comma-separated list of owner/repo',
  },

  // ── Exclusion list mutators (config-only) ────────────────────────────
  {
    key: 'add-language',
    description: 'Append a language to the discovery languages list.',
    settableVia: 'config',
    valueHint: 'string',
  },
  {
    key: 'add-label',
    description: 'Append a label to the discovery labels list.',
    settableVia: 'config',
    valueHint: 'string',
  },
  {
    key: 'remove-label',
    description: 'Remove a label from the discovery labels list.',
    settableVia: 'config',
    valueHint: 'string (must already be present)',
  },
  {
    key: 'add-scope',
    description: 'Append a scope to the discovery scope list.',
    settableVia: 'config',
    valueHint: 'one of: beginner,intermediate,advanced',
  },
  {
    key: 'remove-scope',
    description: 'Remove a scope from the discovery scope list.',
    settableVia: 'config',
    valueHint: 'one of: beginner,intermediate,advanced',
  },
  {
    key: 'exclude-repo',
    description: 'Exclude a specific repo (owner/repo) from discovery.',
    settableVia: 'config',
    valueHint: 'owner/repo',
  },
  {
    key: 'exclude-org',
    description: 'Exclude an entire org from discovery.',
    settableVia: 'config',
    valueHint: 'org name (no slash)',
  },

  // ── Tooling ──────────────────────────────────────────────────────────
  {
    key: 'issueListPath',
    description: 'Path to a text file of extra issue URLs to surface.',
    settableVia: 'both',
    valueHint: 'filesystem path',
  },
  {
    key: 'skippedIssuesPath',
    description: 'Path to the skipped-issues file (auto-culls entries older than 90 days).',
    settableVia: 'setup',
    valueHint: 'filesystem path',
  },
  {
    key: 'diffTool',
    description: 'Default diff renderer for reviews.',
    settableVia: 'both',
    valueHint: 'one of: inline,sourcetree,vscode,custom',
  },
  {
    key: 'diffToolCustomCommand',
    description: 'Shell command template used when diffTool=custom.',
    settableVia: 'both',
    valueHint: 'shell command with {old}/{new} placeholders',
  },

  // ── Behavior ─────────────────────────────────────────────────────────
  {
    key: 'squashByDefault',
    description: 'Default merge strategy — squash-merge, prompt, or standard merge.',
    settableVia: 'setup',
    valueHint: 'true|false|ask',
  },
  {
    key: 'persistence',
    description: 'Where to store state.json — local file or GitHub Gist.',
    settableVia: 'setup',
    valueHint: 'one of: local,gist',
  },
  {
    key: 'autoFormatBeforePush',
    description:
      'Opt-in: run the project formatter and append a `style:` commit before every `git push`. Off by default because formatting commits surprise OSS maintainers; the hook also skips automatically when the branch tracks a fork upstream.',
    settableVia: 'setup',
    valueHint: 'true|false',
  },

  // ── Setup-only completion flag ──────────────────────────────────────
  {
    key: 'complete',
    description:
      'Internal marker that initial setup has finished. Normally set by the wizard — `setup --set complete=true` is a manual override.',
    settableVia: 'setup',
    valueHint: 'true',
  },

  // ── Auto-managed (listed for auditability; not user-settable) ────────
  {
    key: 'starredRepos',
    description: 'Cache of the user’s starred repos. Refreshed automatically during discovery.',
    settableVia: 'auto',
    valueHint: '(managed internally)',
  },
  {
    key: 'starredReposLastFetched',
    description: 'Timestamp of the last starredRepos refresh.',
    settableVia: 'auto',
    valueHint: '(managed internally)',
  },
];

const KEY_INDEX: ReadonlyMap<string, ConfigKeyDef> = new Map(CONFIG_KEY_REGISTRY.map((def) => [def.key, def]));

export function isKnownKey(key: string): boolean {
  return KEY_INDEX.has(key);
}

export function getKeyDef(key: string): ConfigKeyDef | undefined {
  return KEY_INDEX.get(key);
}

/** Keys accepted by the `setup --set` command (includes `both`). */
export function getSetupKeys(): readonly string[] {
  return CONFIG_KEY_REGISTRY.filter((d) => d.settableVia === 'setup' || d.settableVia === 'both').map((d) => d.key);
}

/** Keys accepted by the `config <key> <value>` command (includes `both`). */
export function getConfigKeys(): readonly string[] {
  return CONFIG_KEY_REGISTRY.filter((d) => d.settableVia === 'config' || d.settableVia === 'both').map((d) => d.key);
}

/** Classic iterative Levenshtein. O(n*m) time, O(min(n,m)) space. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure b is the shorter (minimizes row width).
  if (a.length < b.length) [a, b] = [b, a];
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Find the closest known key for a typo, limited to keys accepted by the given
 * CLI surface. Returns `undefined` when no key is close enough (threshold ≤2
 * edits, case-insensitive) — better to say nothing than suggest a wild guess.
 */
export function suggestKey(key: string, surface: 'setup' | 'config'): string | undefined {
  const candidates = surface === 'setup' ? getSetupKeys() : getConfigKeys();
  const lower = key.toLowerCase();
  let best: { key: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const d = levenshtein(lower, candidate.toLowerCase());
    if (best === undefined || d < best.distance) {
      best = { key: candidate, distance: d };
    }
  }
  if (!best) return undefined;
  // Allow up to 2 edits, or 3 when the typo is long (≥8 chars) — forgives one swap + one drop.
  const threshold = key.length >= 8 ? 3 : 2;
  return best.distance <= threshold ? best.key : undefined;
}

/** Format an "unknown key" error, appending a did-you-mean suggestion when confident. */
export function formatUnknownKeyError(key: string, surface: 'setup' | 'config'): string {
  const suggestion = suggestKey(key, surface);
  const base = surface === 'setup' ? `Unknown setting "${key}"` : `Unknown config key "${key}"`;
  if (suggestion) {
    return `${base}. Did you mean "${suggestion}"? Run \`oss-autopilot config --list-keys\` to see all keys.`;
  }
  return `${base}. Run \`oss-autopilot config --list-keys\` to see all keys.`;
}
