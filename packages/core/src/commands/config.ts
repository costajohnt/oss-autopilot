/**
 * Config command
 * Shows or updates configuration
 */

import { getStateManager } from '../core/index.js';
import type { ConfigOutput } from '../formatters/json.js';

interface ConfigOptions {
  key?: string;
  value?: string;
}

export interface ConfigSetOutput {
  success: true;
  key: string;
  value: string;
}

export type ConfigCommandOutput = ConfigOutput | ConfigSetOutput;

export async function runConfig(options: ConfigOptions): Promise<ConfigCommandOutput> {
  const stateManager = getStateManager();
  const currentConfig = stateManager.getState().config;

  if (!options.key) {
    // Show current config
    return { config: currentConfig };
  }

  if (!options.value) {
    throw new Error('Value required');
  }
  const value = options.value;

  // Handle specific config keys
  switch (options.key) {
    case 'username':
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
        throw new Error(
          `Invalid repo format "${value}". Use "owner/repo" format. To exclude an entire org, use: config exclude-org ${value}`,
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
        throw new Error(
          `Invalid org name "${value}". Use just the org name (e.g., "facebook"), not "owner/repo" format. To exclude a specific repo, use: config exclude-repo ${value}`,
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
      throw new Error(`Unknown config key: ${options.key}`);
  }

  stateManager.save();

  return { success: true, key: options.key, value };
}
