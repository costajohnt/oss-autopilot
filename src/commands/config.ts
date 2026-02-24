/**
 * Config command
 * Shows or updates configuration
 */

import { getStateManager } from '../core/index.js';
import { outputJson, outputJsonError, type ConfigOutput } from '../formatters/json.js';

interface ConfigOptions {
  key?: string;
  value?: string;
  json?: boolean;
}

function exitWithError(msg: string, json?: boolean): never {
  if (json) { outputJsonError(msg); } else { console.error(msg); }
  process.exit(1);
}

export async function runConfig(options: ConfigOptions): Promise<void> {
  const stateManager = getStateManager();
  const currentConfig = stateManager.getState().config;

  if (!options.key) {
    // Show current config
    if (options.json) {
      outputJson<ConfigOutput>({ config: currentConfig });
    } else {
      console.log('\n⚙️ Current Configuration:\n');
      console.log(JSON.stringify(currentConfig, null, 2));
    }
    return;
  }

  if (!options.value) {
    exitWithError('Value required', options.json);
  }

  // Handle specific config keys
  switch (options.key) {
    case 'username':
      stateManager.updateConfig({ githubUsername: options.value });
      break;
    case 'add-language':
      if (!currentConfig.languages.includes(options.value)) {
        stateManager.updateConfig({ languages: [...currentConfig.languages, options.value] });
      }
      break;
    case 'add-label':
      if (!currentConfig.labels.includes(options.value)) {
        stateManager.updateConfig({ labels: [...currentConfig.labels, options.value] });
      }
      break;
    case 'exclude-repo': {
      const parts = options.value.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        exitWithError(
          `Invalid repo format "${options.value}". Use "owner/repo" format. To exclude an entire org, use: config exclude-org ${options.value}`,
          options.json,
        );
      }
      if (!currentConfig.excludeRepos.includes(options.value)) {
        stateManager.updateConfig({ excludeRepos: [...currentConfig.excludeRepos, options.value] });
        stateManager.cleanupExcludedData([options.value], []);
      }
      break;
    }
    case 'exclude-org': {
      if (options.value.includes('/')) {
        exitWithError(
          `Invalid org name "${options.value}". Use just the org name (e.g., "facebook"), not "owner/repo" format. To exclude a specific repo, use: config exclude-repo ${options.value}`,
          options.json,
        );
      }
      const currentOrgs = currentConfig.excludeOrgs ?? [];
      if (!currentOrgs.includes(options.value)) {
        stateManager.updateConfig({ excludeOrgs: [...currentOrgs, options.value] });
        stateManager.cleanupExcludedData([], [options.value]);
      }
      break;
    }
    default:
      exitWithError(`Unknown config key: ${options.key}`, options.json);
  }

  stateManager.save();

  if (options.json) {
    outputJson({ success: true, key: options.key, value: options.value });
  } else {
    console.log(`Set ${options.key} to: ${options.value}`);
  }
}
