/**
 * Setup command
 * Interactive setup / configuration
 */

import { getStateManager } from '../core/index.js';
import { outputJson } from '../formatters/json.js';

interface SetupOptions {
  reset?: boolean;
  set?: string[];
  json?: boolean;
}

interface CheckSetupOptions {
  json?: boolean;
}

export async function runSetup(options: SetupOptions): Promise<void> {
  const stateManager = getStateManager();
  const config = stateManager.getState().config;

  // Handle --set mode: apply settings directly
  if (options.set && options.set.length > 0) {
    const results: Record<string, string> = {};

    for (const setting of options.set) {
      const [key, ...valueParts] = setting.split('=');
      const value = valueParts.join('=');

      switch (key) {
        case 'username':
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
          stateManager.updateConfig({ languages: value.split(',').map(l => l.trim()) });
          results[key] = value;
          break;
        case 'labels':
          stateManager.updateConfig({ labels: value.split(',').map(l => l.trim()) });
          results[key] = value;
          break;
        case 'complete':
          if (value === 'true') {
            stateManager.markSetupComplete();
            results[key] = 'true';
          }
          break;
        default:
          if (!options.json) {
            console.warn(`Unknown setting: ${key}`);
          }
      }
    }

    stateManager.save();

    if (options.json) {
      outputJson({ success: true, settings: results });
    } else {
      for (const [key, value] of Object.entries(results)) {
        console.log(`✓ ${key}: ${value}`);
      }
    }
    return;
  }

  // Show setup status
  if (config.setupComplete && !options.reset) {
    if (options.json) {
      outputJson({
        setupComplete: true,
        config: {
          githubUsername: config.githubUsername,
          maxActivePRs: config.maxActivePRs,
          dormantThresholdDays: config.dormantThresholdDays,
          approachingDormantDays: config.approachingDormantDays,
          languages: config.languages,
          labels: config.labels,
        },
      });
    } else {
      console.log('\n⚙️  OSS Autopilot Setup\n');
      console.log('✓ Setup already complete!\n');
      console.log('Current settings:');
      console.log(`  GitHub username:    ${config.githubUsername || '(not set)'}`);
      console.log(`  Max active PRs:     ${config.maxActivePRs}`);
      console.log(`  Dormant threshold:  ${config.dormantThresholdDays} days`);
      console.log(`  Approaching dormant: ${config.approachingDormantDays} days`);
      console.log(`  Languages:          ${config.languages.join(', ')}`);
      console.log(`  Labels:             ${config.labels.join(', ')}`);
      console.log(`\nRun 'setup --reset' to reconfigure.`);
    }
    return;
  }

  // Output setup prompts
  if (options.json) {
    outputJson({
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
      ],
    });
  } else {
    console.log('\n⚙️  OSS Autopilot Setup\n');
    console.log('SETUP_REQUIRED');
    console.log('---');
    console.log('Please configure the following settings:\n');

    console.log('SETTING: username');
    console.log('PROMPT: What is your GitHub username?');
    console.log(`CURRENT: ${config.githubUsername || '(not set)'}`);
    console.log('REQUIRED: true');
    console.log('');

    console.log('SETTING: maxActivePRs');
    console.log('PROMPT: How many PRs do you want to work on at once?');
    console.log(`CURRENT: ${config.maxActivePRs}`);
    console.log('DEFAULT: 10');
    console.log('TYPE: number');
    console.log('');

    console.log('SETTING: dormantDays');
    console.log('PROMPT: After how many days of inactivity should a PR be considered dormant?');
    console.log(`CURRENT: ${config.dormantThresholdDays}`);
    console.log('DEFAULT: 30');
    console.log('TYPE: number');
    console.log('');

    console.log('SETTING: approachingDays');
    console.log('PROMPT: At how many days should we warn about approaching dormancy?');
    console.log(`CURRENT: ${config.approachingDormantDays}`);
    console.log('DEFAULT: 25');
    console.log('TYPE: number');
    console.log('');

    console.log('SETTING: languages');
    console.log('PROMPT: What programming languages do you want to contribute to? (comma-separated)');
    console.log(`CURRENT: ${config.languages.join(', ')}`);
    console.log('DEFAULT: typescript, javascript');
    console.log('TYPE: list');
    console.log('');

    console.log('SETTING: labels');
    console.log('PROMPT: What issue labels should we search for? (comma-separated)');
    console.log(`CURRENT: ${config.labels.join(', ')}`);
    console.log('DEFAULT: good first issue, help wanted');
    console.log('TYPE: list');
    console.log('');

    console.log('---');
    console.log('END_SETUP_PROMPTS');
  }
}

export async function runCheckSetup(options: CheckSetupOptions): Promise<void> {
  const stateManager = getStateManager();

  if (options.json) {
    outputJson({
      setupComplete: stateManager.isSetupComplete(),
      username: stateManager.getState().config.githubUsername,
    });
  } else {
    if (stateManager.isSetupComplete()) {
      console.log('SETUP_COMPLETE');
      console.log(`username=${stateManager.getState().config.githubUsername}`);
    } else {
      console.log('SETUP_INCOMPLETE');
    }
  }
}
