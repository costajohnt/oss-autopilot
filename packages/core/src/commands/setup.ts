/**
 * Setup command
 * Interactive setup / configuration
 */

import { getStateManager, DEFAULT_CONFIG } from '../core/index.js';
import { validateGitHubUsername } from './validation.js';

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

    for (const setting of options.set) {
      const [key, ...valueParts] = setting.split('=');
      const value = valueParts.join('=');

      switch (key) {
        case 'username':
          validateGitHubUsername(value);
          stateManager.updateConfig({ githubUsername: value });
          results[key] = value;
          break;
        case 'maxActivePRs':
          stateManager.updateConfig({ maxActivePRs: parseInt(value) || 10 });
          results[key] = value;
          break;
        case 'dormantDays':
          stateManager.updateConfig({ dormantThresholdDays: parseInt(value) || 30 });
          results[key] = value;
          break;
        case 'approachingDays':
          stateManager.updateConfig({ approachingDormantDays: parseInt(value) || 25 });
          results[key] = value;
          break;
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
          const parsed = parseInt(value);
          stateManager.updateConfig({ minStars: isNaN(parsed) ? 50 : parsed });
          results[key] = value;
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

    stateManager.save();

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
        setting: 'aiPolicyBlocklist',
        prompt: 'Repos with anti-AI contribution policies to block (owner/repo, comma-separated)?',
        current: config.aiPolicyBlocklist ?? DEFAULT_CONFIG.aiPolicyBlocklist ?? null,
        default: ['matplotlib/matplotlib'],
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
