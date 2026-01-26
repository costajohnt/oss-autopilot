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
    if (options.json) {
      outputJsonError('Value required');
    } else {
      console.error('Usage: oss-autopilot config <key> <value>');
    }
    process.exit(1);
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
    case 'exclude-repo':
      if (!currentConfig.excludeRepos.includes(options.value)) {
        stateManager.updateConfig({ excludeRepos: [...currentConfig.excludeRepos, options.value] });
      }
      break;
    default:
      if (options.json) {
        outputJsonError(`Unknown config key: ${options.key}`);
      } else {
        console.error(`Unknown config key: ${options.key}`);
      }
      process.exit(1);
  }

  stateManager.save();

  if (options.json) {
    outputJson({ success: true, key: options.key, value: options.value });
  } else {
    console.log(`Set ${options.key} to: ${options.value}`);
  }
}
