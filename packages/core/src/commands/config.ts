/**
 * Config command
 * Shows or updates configuration
 */

import { getStateManager } from '../core/index.js';
import { ISSUE_SCOPES, type IssueScope } from '../core/types.js';
import type { ConfigOutput } from '../formatters/json.js';
import { validateGitHubUsername } from './validation.js';

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

function validateScope(value: string): IssueScope {
  if (!(ISSUE_SCOPES as readonly string[]).includes(value)) {
    throw new Error(`Invalid scope "${value}". Valid scopes: ${ISSUE_SCOPES.join(', ')}`);
  }
  return value as IssueScope;
}

/**
 * Read or write user configuration settings.
 * When called without a key, returns the full config.
 * When called with a key and value, updates the setting.
 *
 * @param options - Config options
 * @param options.key - Setting key (e.g., 'username', 'add-language', 'exclude-repo')
 * @param options.value - Setting value (required when key is provided)
 * @returns Current config (when reading) or success confirmation (when writing)
 * @throws {Error} If the key is unknown or the value is invalid
 */
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
      stateManager.updateConfig({ githubUsername: validateGitHubUsername(value) });
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
    case 'remove-label':
      if (!currentConfig.labels.includes(value)) {
        throw new Error(
          `Label "${value}" is not currently configured. Current labels: ${currentConfig.labels.join(', ')}`,
        );
      }
      stateManager.updateConfig({ labels: currentConfig.labels.filter((l) => l !== value) });
      break;
    case 'add-scope': {
      const scope = validateScope(value);
      const currentScopes = currentConfig.scope ?? [];
      if (!currentScopes.includes(scope)) {
        stateManager.updateConfig({ scope: [...currentScopes, scope] });
      }
      break;
    }
    case 'remove-scope': {
      const scope = validateScope(value);
      const existingScopes = currentConfig.scope ?? [];
      if (!existingScopes.includes(scope)) {
        throw new Error(`Scope "${value}" is not currently set`);
      }
      const filtered = existingScopes.filter((s) => s !== scope);
      if (filtered.length === 0) {
        throw new Error('Cannot remove the last scope. Use setup to clear scopes entirely.');
      }
      stateManager.updateConfig({ scope: filtered });
      break;
    }
    case 'exclude-repo': {
      const parts = value.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(
          `Invalid repo format "${value}". Use "owner/repo" format. To exclude an entire org, use: config exclude-org ${value}`,
        );
      }
      const valueLower = value.toLowerCase();
      if (!currentConfig.excludeRepos.some((r) => r.toLowerCase() === valueLower)) {
        stateManager.batch(() => {
          stateManager.updateConfig({ excludeRepos: [...currentConfig.excludeRepos, value] });
          stateManager.cleanupExcludedData([value], []);
        });
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
        stateManager.batch(() => {
          stateManager.updateConfig({ excludeOrgs: [...currentOrgs, value] });
          stateManager.cleanupExcludedData([], [value]);
        });
      }
      break;
    }
    case 'issueListPath':
      stateManager.updateConfig({ issueListPath: value || undefined });
      break;
    case 'scoreThreshold': {
      const threshold = Number(value);
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10) {
        throw new Error('Invalid value for scoreThreshold. Must be an integer between 1 and 10.');
      }
      stateManager.updateConfig({ scoreThreshold: threshold });
      break;
    }
    default:
      throw new Error(`Unknown config key: ${options.key}`);
  }

  return { success: true, key: options.key, value };
}
