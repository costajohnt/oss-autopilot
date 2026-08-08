/**
 * Setup command
 * Interactive setup / configuration
 */

import {
  getStateManager,
  DEFAULT_CONFIG,
  formatUnknownKeyError,
  getSetupKeys,
  maybeCheckpoint,
} from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { validateGitHubUsername } from './validation.js';
import {
  PROJECT_CATEGORIES,
  type ProjectCategory,
  ISSUE_SCOPES,
  type IssueScope,
  DIFF_TOOLS,
  type DiffTool,
} from '../core/types.js';

const MODULE = 'setup';

/** Parse and validate a positive integer setting value. */
function parsePositiveInt(value: string, settingName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError(`Invalid value for ${settingName}: "${value}". Must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string, settingName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ValidationError(`Invalid value for ${settingName}: "${value}". Must be a non-negative integer.`);
  }
  return parsed;
}

interface SetupOptions {
  reset?: boolean;
  set?: string[];
}

export interface SetupSetOutput {
  success: true;
  settings: Record<string, string>;
  warnings?: string[];
  /** Set when the post-mutation Gist checkpoint failed; the local mutation succeeded (#1440). */
  gistSyncWarning?: string;
}

export interface SetupCompleteOutput {
  setupComplete: true;
  config: {
    githubUsername: string;
    maxActivePRs: number;
    dormantThresholdDays: number;
    approachingDormantDays: number;
    languages: string[];
    labels: string[];
    projectCategories: ProjectCategory[];
    preferredOrgs: string[];
    scope: IssueScope[];
    persistence: 'local' | 'gist';
  };
}

export interface SetupPrompt {
  setting: string;
  prompt: string;
  current: string | number | string[] | null;
  required?: boolean;
  default?: string | number | string[];
  type?: string;
}

export interface SetupRequiredOutput {
  setupRequired: true;
  prompts: SetupPrompt[];
}

export type SetupOutput = SetupSetOutput | SetupCompleteOutput | SetupRequiredOutput;

export interface CheckSetupOutput {
  setupComplete: boolean;
  username: string;
}

/**
 * Interactive setup wizard or direct setting application.
 *
 * Three modes:
 * 1. `--set key=value` — Apply settings directly
 * 2. Setup complete — Return current config
 * 3. Setup required — Return prompts for interactive setup
 *
 * @param options - Setup options
 * @param options.reset - Force re-setup even if already complete
 * @param options.set - Key=value pairs to apply directly
 * @returns Setup result (applied settings, current config, or setup prompts)
 */
export async function runSetup(options: SetupOptions): Promise<SetupOutput> {
  const stateManager = getStateManager();
  const config = stateManager.getState().config;

  // Handle --set mode: apply settings directly
  if (options.set && options.set.length > 0) {
    const results: Record<string, string> = {};
    const warnings: string[] = [];

    // Pre-validate every key before mutating state. `stateManager.batch()` only
    // defers the disk write — it does not snapshot in-memory state, so throwing
    // mid-loop would leave earlier successful updates applied in memory (a real
    // issue for long-running consumers like the MCP server and dashboard that
    // share the StateManager singleton across requests).
    const knownKeys = new Set(getSetupKeys());
    for (const setting of options.set) {
      const [key] = setting.split('=');
      if (!knownKeys.has(key)) {
        throw new ValidationError(formatUnknownKeyError(key, 'setup'));
      }
    }

    stateManager.batch(() => {
      for (const setting of options.set!) {
        const [key, ...valueParts] = setting.split('=');
        const value = valueParts.join('=');

        switch (key) {
          case 'username': {
            validateGitHubUsername(value);
            stateManager.updateConfig({ githubUsername: value });
            results[key] = value;
            break;
          }
          case 'maxActivePRs': {
            const maxPRs = parsePositiveInt(value, 'maxActivePRs');
            stateManager.updateConfig({ maxActivePRs: maxPRs });
            results[key] = String(maxPRs);
            break;
          }
          case 'dormantDays': {
            const dormant = parsePositiveInt(value, 'dormantDays');
            stateManager.updateConfig({ dormantThresholdDays: dormant });
            results[key] = String(dormant);
            break;
          }
          case 'approachingDays': {
            const approaching = parsePositiveInt(value, 'approachingDays');
            stateManager.updateConfig({ approachingDormantDays: approaching });
            results[key] = String(approaching);
            break;
          }
          case 'languages': {
            stateManager.updateConfig({ languages: value.split(',').map((l) => l.trim()) });
            results[key] = value;
            break;
          }
          case 'labels': {
            stateManager.updateConfig({ labels: value.split(',').map((l) => l.trim()) });
            results[key] = value;
            break;
          }
          case 'squashByDefault': {
            if (value === 'ask') {
              stateManager.updateConfig({ squashByDefault: 'ask' });
              results[key] = 'ask';
            } else {
              stateManager.updateConfig({ squashByDefault: value !== 'false' });
              results[key] = value !== 'false' ? 'true' : 'false';
            }
            break;
          }
          case 'minStars': {
            const stars = Number(value);
            if (!Number.isInteger(stars) || stars < 0) {
              throw new ValidationError(`Invalid value for minStars: "${value}". Must be a non-negative integer.`);
            }
            stateManager.updateConfig({ minStars: stars });
            results[key] = String(stars);
            break;
          }
          case 'maxIssueAgeDays': {
            const days = parsePositiveInt(value, 'maxIssueAgeDays');
            stateManager.updateConfig({ maxIssueAgeDays: days });
            results[key] = String(days);
            break;
          }
          case 'minRepoScoreThreshold': {
            const threshold = Number(value);
            if (!Number.isInteger(threshold) || threshold < 0) {
              throw new ValidationError(
                `Invalid value for minRepoScoreThreshold: "${value}". Must be a non-negative integer.`,
              );
            }
            stateManager.updateConfig({ minRepoScoreThreshold: threshold });
            results[key] = String(threshold);
            break;
          }
          case 'skippedIssuesPath': {
            stateManager.updateConfig({ skippedIssuesPath: value || undefined });
            results[key] = value || '(cleared)';
            break;
          }
          case 'autoFormatBeforePush': {
            if (value !== 'true' && value !== 'false') {
              throw new ValidationError(
                `Invalid value for autoFormatBeforePush: "${value}". Must be "true" or "false".`,
              );
            }
            const enabled = value === 'true';
            stateManager.updateConfig({ autoFormatBeforePush: enabled });
            results[key] = String(enabled);
            break;
          }
          case 'trustOwnRepoWrites': {
            if (value !== 'true' && value !== 'false') {
              throw new ValidationError(`Invalid value for trustOwnRepoWrites: "${value}". Must be "true" or "false".`);
            }
            const trusted = value === 'true';
            stateManager.updateConfig({ trustOwnRepoWrites: trusted });
            results[key] = String(trusted);
            break;
          }
          case 'includeDocIssues': {
            stateManager.updateConfig({ includeDocIssues: value === 'true' });
            results[key] = value === 'true' ? 'true' : 'false';
            break;
          }
          case 'aiPolicyBlocklist': {
            const entries = value
              .split(',')
              .map((r) => r.trim())
              .filter(Boolean);
            const valid: string[] = [];
            const invalid: string[] = [];
            for (const entry of entries) {
              const normalized = entry.replace(/\s+/g, '');
              if (/^[\w.-]+\/[\w.-]+$/.test(normalized)) {
                valid.push(normalized);
              } else {
                invalid.push(entry);
              }
            }
            if (invalid.length > 0) {
              warnings.push(`Warning: Skipping invalid entries (expected "owner/repo" format): ${invalid.join(', ')}`);
              results['aiPolicyBlocklist_invalidEntries'] = invalid.join(', ');
            }
            if (valid.length === 0 && entries.length > 0) {
              warnings.push('Warning: All entries were invalid. Blocklist not updated.');
              results[key] = '(all entries invalid)';
              break;
            }
            stateManager.updateConfig({ aiPolicyBlocklist: valid });
            results[key] = valid.length > 0 ? valid.join(', ') : '(empty)';
            break;
          }
          case 'avoidRepos': {
            // Same owner/repo validation as aiPolicyBlocklist: skip (and warn
            // about) malformed entries instead of failing the whole set.
            const entries = value
              .split(',')
              .map((r) => r.trim())
              .filter(Boolean);
            const valid: string[] = [];
            const invalid: string[] = [];
            for (const entry of entries) {
              const normalized = entry.replace(/\s+/g, '');
              if (/^[\w.-]+\/[\w.-]+$/.test(normalized)) {
                valid.push(normalized);
              } else {
                invalid.push(entry);
              }
            }
            if (invalid.length > 0) {
              warnings.push(`Warning: Skipping invalid entries (expected "owner/repo" format): ${invalid.join(', ')}`);
            }
            if (valid.length === 0 && entries.length > 0) {
              warnings.push('Warning: All entries were invalid. avoidRepos not updated.');
              results[key] = '(all entries invalid)';
              break;
            }
            const dedupedRepos = [...new Set(valid)];
            stateManager.updateConfig({ avoidRepos: dedupedRepos });
            results[key] = dedupedRepos.length > 0 ? dedupedRepos.join(', ') : '(empty)';
            break;
          }
          case 'boostIssueTypes': {
            // Free-form issue labels (scout matches them case-insensitively);
            // an empty value clears the list.
            const types = [
              ...new Set(
                value
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
              ),
            ];
            stateManager.updateConfig({ boostIssueTypes: types });
            results[key] = types.length > 0 ? types.join(', ') : '(empty)';
            break;
          }
          case 'projectCategories': {
            const categories = value
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean);
            const validCategories: ProjectCategory[] = [];
            const invalidCategories: string[] = [];
            for (const cat of categories) {
              if ((PROJECT_CATEGORIES as readonly string[]).includes(cat)) {
                validCategories.push(cat as ProjectCategory);
              } else {
                invalidCategories.push(cat);
              }
            }
            if (invalidCategories.length > 0) {
              warnings.push(
                `Unknown project categories: ${invalidCategories.join(', ')}. Valid: ${PROJECT_CATEGORIES.join(', ')}`,
              );
            }
            const dedupedCategories = [...new Set(validCategories)];
            stateManager.updateConfig({ projectCategories: dedupedCategories });
            results[key] = dedupedCategories.length > 0 ? dedupedCategories.join(', ') : '(empty)';
            break;
          }
          case 'preferredOrgs': {
            const orgs = value
              .split(',')
              .map((o) => o.trim())
              .filter(Boolean);
            const validOrgs: string[] = [];
            for (const org of orgs) {
              if (org.includes('/')) {
                warnings.push(
                  `"${org}" looks like a repo path. Use org name only (e.g., "vercel" not "vercel/next.js").`,
                );
              } else if (!/^[\da-z](?:[\da-z-]*[\da-z])?$/i.test(org)) {
                warnings.push(`"${org}" is not a valid GitHub organization name. Skipping.`);
              } else {
                validOrgs.push(org.toLowerCase());
              }
            }
            const dedupedOrgs = [...new Set(validOrgs)];
            stateManager.updateConfig({ preferredOrgs: dedupedOrgs });
            results[key] = dedupedOrgs.length > 0 ? dedupedOrgs.join(', ') : '(empty)';
            break;
          }
          case 'scope': {
            const scopeValues = value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const validScopes: IssueScope[] = [];
            const invalidScopes: string[] = [];
            for (const s of scopeValues) {
              if ((ISSUE_SCOPES as readonly string[]).includes(s)) {
                validScopes.push(s as IssueScope);
              } else {
                invalidScopes.push(s);
              }
            }
            if (invalidScopes.length > 0) {
              warnings.push(`Unknown issue scopes: ${invalidScopes.join(', ')}. Valid: ${ISSUE_SCOPES.join(', ')}`);
            }
            const dedupedScopes = [...new Set(validScopes)];
            stateManager.updateConfig({ scope: dedupedScopes.length > 0 ? dedupedScopes : undefined });
            results[key] = dedupedScopes.length > 0 ? dedupedScopes.join(', ') : '(empty — using labels only)';
            break;
          }
          case 'persistence': {
            if (value !== 'local' && value !== 'gist') {
              throw new ValidationError(`Invalid value for persistence: "${value}". Must be "local" or "gist".`);
            }
            stateManager.updateConfig({ persistence: value as 'local' | 'gist' });
            results[key] = value;
            break;
          }
          case 'issueListPath': {
            stateManager.updateConfig({ issueListPath: value || undefined });
            results[key] = value || '(cleared)';
            break;
          }
          case 'diffTool': {
            if (!(DIFF_TOOLS as readonly string[]).includes(value)) {
              warnings.push(`Invalid diffTool "${value}". Valid: ${DIFF_TOOLS.join(', ')}`);
              break;
            }
            stateManager.updateConfig({ diffTool: value as DiffTool });
            results[key] = value;
            break;
          }
          case 'diffToolCustomCommand': {
            stateManager.updateConfig({ diffToolCustomCommand: value || undefined });
            results[key] = value || '(cleared)';
            break;
          }
          case 'skipBroadWhenSufficientResults': {
            // 0 is valid and meaningful ("always run the broad phase"), so this
            // key allows zero unlike the positive-int keys above.
            const threshold = parseNonNegativeInt(value, 'skipBroadWhenSufficientResults');
            stateManager.updateConfig({ skipBroadWhenSufficientResults: threshold });
            results[key] = String(threshold);
            break;
          }
          case 'healthCheckFreshnessMinutes': {
            const minutes = parsePositiveInt(value, 'healthCheckFreshnessMinutes');
            stateManager.updateConfig({ healthCheckFreshnessMinutes: minutes });
            results[key] = String(minutes);
            break;
          }
          case 'reviewMaxPasses': {
            const passes = parsePositiveInt(value, 'reviewMaxPasses');
            stateManager.updateConfig({ reviewMaxPasses: passes });
            results[key] = String(passes);
            break;
          }
          case 'complete': {
            if (value === 'true') {
              stateManager.markSetupComplete();
              results[key] = 'true';
            }
            break;
          }
          default: {
            throw new ValidationError(formatUnknownKeyError(key, 'setup'));
          }
        }
      }
    });

    // Push the settings mutation to the Gist in gist mode (no-op locally).
    // Without this the change only hits the local cache and the next
    // bootstrap reverts it from the Gist (#1440).
    const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);
    return {
      success: true,
      settings: results,
      warnings: warnings.length > 0 ? warnings : undefined,
      ...(gistSyncWarning ? { gistSyncWarning } : {}),
    };
  }

  // Show setup status
  if (config.setupComplete && !options.reset) {
    return {
      setupComplete: true,
      config: {
        githubUsername: config.githubUsername,
        maxActivePRs: config.maxActivePRs,
        dormantThresholdDays: config.dormantThresholdDays,
        approachingDormantDays: config.approachingDormantDays,
        languages: config.languages,
        labels: config.labels,
        projectCategories: config.projectCategories ?? [],
        preferredOrgs: config.preferredOrgs ?? [],
        scope: config.scope ?? [],
        persistence: config.persistence ?? 'local',
      },
    };
  }

  // Output setup prompts
  return {
    setupRequired: true,
    prompts: [
      {
        setting: 'username',
        prompt: 'What is your GitHub username?',
        current: config.githubUsername || null,
        required: true,
        type: 'string',
      },
      {
        setting: 'maxActivePRs',
        prompt: 'How many PRs do you want to work on at once?',
        current: config.maxActivePRs,
        default: 10,
        type: 'number',
      },
      {
        setting: 'dormantDays',
        prompt: 'After how many days of inactivity should a PR be considered dormant?',
        current: config.dormantThresholdDays,
        default: 30,
        type: 'number',
      },
      {
        setting: 'approachingDays',
        prompt: 'At how many days should we warn about approaching dormancy?',
        current: config.approachingDormantDays,
        default: 25,
        type: 'number',
      },
      {
        setting: 'languages',
        prompt: 'What programming languages do you want to contribute to?',
        current: config.languages,
        default: ['typescript', 'javascript'],
        type: 'list',
      },
      {
        setting: 'labels',
        prompt: 'What issue labels should we search for?',
        current: config.labels,
        default: ['good first issue', 'help wanted'],
        type: 'list',
      },
      {
        setting: 'scope',
        prompt:
          'What scope of issues do you want to discover? (beginner, intermediate, advanced — leave empty for default labels only)',
        current: config.scope ?? [],
        default: [],
        type: 'list',
      },
      {
        setting: 'aiPolicyBlocklist',
        prompt: 'Repos with anti-AI contribution policies to block (owner/repo, comma-separated)?',
        current: config.aiPolicyBlocklist ?? DEFAULT_CONFIG.aiPolicyBlocklist ?? null,
        default: ['matplotlib/matplotlib'],
        type: 'list',
      },
      {
        setting: 'projectCategories',
        prompt:
          'What types of projects interest you? (nonprofit, devtools, infrastructure, web-frameworks, data-ml, education)',
        current: config.projectCategories ?? [],
        default: [],
        type: 'list',
      },
      {
        setting: 'preferredOrgs',
        prompt: 'Any GitHub organizations to prioritize? (org names, comma-separated)',
        current: config.preferredOrgs ?? [],
        default: [],
        type: 'list',
      },
      {
        setting: 'persistence',
        prompt: 'Where should state be stored? "local" for file only, "gist" for GitHub Gist (survives device loss)',
        current: config.persistence ?? 'local',
        default: 'local',
        type: 'string',
      },
    ],
  };
}

/**
 * Check whether initial setup has been completed.
 * @returns Setup status and configured username
 */
export async function runCheckSetup(): Promise<CheckSetupOutput> {
  const stateManager = getStateManager();

  return {
    setupComplete: stateManager.isSetupComplete(),
    username: stateManager.getState().config.githubUsername,
  };
}
