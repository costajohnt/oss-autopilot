/**
 * Config command
 * Shows or updates configuration
 */

import { getStateManager } from '../core/index.js';
import { outputJson, outputJsonError, type ConfigOutput } from '../formatters/json.js';
import { validateGitHubUsername } from './validation.js';

interface ConfigOptions {
  key?: string;
  value?: string;
  json?: boolean;
}

function exitWithError(msg: string, json?: boolean): never {
  if (json) {
    outputJsonError(msg);
  } else {
    console.error(msg);
  }
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
  const value = options.value;

  // Handle specific config keys
  switch (options.key) {
    case 'username':
      try {
        validateGitHubUsername(value);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        exitWithError(msg, options.json);
      }
      stateManager.updateConfig({ githubUsername: value });
      break;
    case 'add-language':
      if (!currentConfig.languages.includes(value)) {
        stateManager.updateConfig({ languages: [...currentConfig.languages, value] });
      }
      break;
    case 'add-label':
      if (!currentConfig.labels.includes(value)) {
        stateManager.updateConfig({ labels: [...currentConfig.labels, value] });
      }
      break;
    case 'exclude-repo': {
      const parts = value.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        exitWithError(
          `Invalid repo format "${value}". Use "owner/repo" format. To exclude an entire org, use: config exclude-org ${value}`,
          options.json,
        );
      }
      const valueLower = value.toLowerCase();
      if (!currentConfig.excludeRepos.some((r) => r.toLowerCase() === valueLower)) {
        stateManager.updateConfig({ excludeRepos: [...currentConfig.excludeRepos, value] });
        stateManager.cleanupExcludedData([value], []);
      }
      break;
    }
    case 'exclude-org': {
      if (value.includes('/')) {
        exitWithError(
          `Invalid org name "${value}". Use just the org name (e.g., "facebook"), not "owner/repo" format. To exclude a specific repo, use: config exclude-repo ${value}`,
          options.json,
        );
      }
      const currentOrgs = currentConfig.excludeOrgs ?? [];
      if (!currentOrgs.some((o) => o.toLowerCase() === value.toLowerCase())) {
        stateManager.updateConfig({ excludeOrgs: [...currentOrgs, value] });
        stateManager.cleanupExcludedData([], [value]);
      }
      break;
    }
    default:
      exitWithError(`Unknown config key: ${options.key}`, options.json);
  }

  stateManager.save();

  if (options.json) {
    outputJson({ success: true, key: options.key, value });
  } else {
    console.log(`Set ${options.key} to: ${value}`);
  }
}
