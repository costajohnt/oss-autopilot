/**
 * Setup command
 * Interactive setup / configuration
 */

import { getStateManager, DEFAULT_CONFIG } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { validateGitHubUsername } from './validation.js';
import { PROJECT_CATEGORIES, type ProjectCategory, ISSUE_SCOPES, type IssueScope } from '../core/types.js';

/** Parse and validate a positive integer setting value. */
function parsePositiveInt(value: string, settingName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    throw new ValidationError(`Invalid value for ${settingName}: "${value}". Must be a positive integer.`);
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

export async function runSetup(options: SetupOptions): Promise<SetupOutput> {
  const stateManager = getStateManager();
  const config = stateManager.getState().config;

  // Handle --set mode: apply settings directly
  if (options.set && options.set.length > 0) {
    const results: Record<string, string> = {};
    const warnings: string[] = [];

    stateManager.batch(() => {
      for (const setting of options.set!) {
        const [key, ...valueParts] = setting.split('=');
        const value = valueParts.join('=');

        switch (key) {
          case 'username':
            validateGitHubUsername(value);
            stateManager.updateConfig({ githubUsername: value });
            results[key] = value;
            break;
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
          case 'languages':
            stateManager.updateConfig({ languages: value.split(',').map((l) => l.trim()) });
            results[key] = value;
            break;
          case 'labels':
            stateManager.updateConfig({ labels: value.split(',').map((l) => l.trim()) });
            results[key] = value;
            break;
          case 'showHealthCheck':
            stateManager.updateConfig({ showHealthCheck: value !== 'false' });
            results[key] = value !== 'false' ? 'true' : 'false';
            break;
          case 'squashByDefault':
            if (value === 'ask') {
              stateManager.updateConfig({ squashByDefault: 'ask' });
              results[key] = 'ask';
            } else {
              stateManager.updateConfig({ squashByDefault: value !== 'false' });
              results[key] = value !== 'false' ? 'true' : 'false';
            }
            break;
          case 'minStars': {
            const stars = Number(value);
            if (!Number.isFinite(stars) || !Number.isInteger(stars) || stars < 0) {
              throw new ValidationError(`Invalid value for minStars: "${value}". Must be a non-negative integer.`);
            }
            stateManager.updateConfig({ minStars: stars });
            results[key] = String(stars);
            break;
          }
          case 'includeDocIssues':
            stateManager.updateConfig({ includeDocIssues: value === 'true' });
            results[key] = value === 'true' ? 'true' : 'false';
            break;
          case 'aiPolicyBlocklist': {
            const entries = value
              .split(',')
              .map((r) => r.trim())
              .filter(Boolean);
            const valid: string[] = [];
            const invalid: string[] = [];
            for (const entry of entries) {
              const normalized = entry.replace(/\s+/g, '');
              if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(normalized)) {
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
              } else if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(org)) {
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
          case 'issueListPath':
            stateManager.updateConfig({ issueListPath: value || undefined });
            results[key] = value || '(cleared)';
            break;
          case 'complete':
            if (value === 'true') {
              stateManager.markSetupComplete();
              results[key] = 'true';
            }
            break;
          default:
            warnings.push(`Unknown setting: ${key}`);
        }
      }
    });

    return { success: true, settings: results, warnings: warnings.length > 0 ? warnings : undefined };
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
    ],
  };
}

export async function runCheckSetup(): Promise<CheckSetupOutput> {
  const stateManager = getStateManager();

  return {
    setupComplete: stateManager.isSetupComplete(),
    username: stateManager.getState().config.githubUsername,
  };
}
