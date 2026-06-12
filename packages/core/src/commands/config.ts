/**
 * Config command
 * Shows or updates configuration
 */

import { CONFIG_KEY_REGISTRY, type ConfigKeyDef, formatUnknownKeyError, getStateManager } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { ISSUE_SCOPES, type IssueScope, DIFF_TOOLS, type DiffTool } from '../core/types.js';
import type { ConfigOutput } from '../formatters/json.js';
import { validateGitHubUsername } from './validation.js';

interface ConfigOptions {
  key?: string;
  value?: string;
  listKeys?: boolean;
}

export interface ConfigSetOutput {
  success: true;
  key: string;
  value: string;
}

export interface ConfigListKeysOutput {
  keys: readonly ConfigKeyDef[];
}

export type ConfigCommandOutput = ConfigOutput | ConfigSetOutput | ConfigListKeysOutput;

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
 * When called with --list-keys, returns the full registry of known keys.
 *
 * @param options - Config options
 * @param options.key - Setting key (e.g., 'username', 'add-language', 'exclude-repo')
 * @param options.value - Setting value (required when key is provided)
 * @param options.listKeys - When true, return the registry of known keys
 * @returns Current config, success confirmation, or key registry
 * @throws {Error} If the key is unknown or the value is invalid
 */
export async function runConfig(options: ConfigOptions): Promise<ConfigCommandOutput> {
  if (options.listKeys) {
    if (options.key || options.value) {
      throw new ValidationError(
        '`--list-keys` cannot be combined with a key/value. Run `config --list-keys` on its own.',
      );
    }
    return { keys: CONFIG_KEY_REGISTRY };
  }

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
    case 'username': {
      stateManager.updateConfig({ githubUsername: validateGitHubUsername(value) });
      break;
    }
    case 'add-language': {
      if (!currentConfig.languages.includes(value)) {
        stateManager.updateConfig({ languages: [...currentConfig.languages, value] });
      }
      break;
    }
    case 'add-label': {
      if (!currentConfig.labels.includes(value)) {
        stateManager.updateConfig({ labels: [...currentConfig.labels, value] });
      }
      break;
    }
    case 'remove-label': {
      if (!currentConfig.labels.includes(value)) {
        throw new Error(
          `Label "${value}" is not currently configured. Current labels: ${currentConfig.labels.join(', ')}`,
        );
      }
      stateManager.updateConfig({ labels: currentConfig.labels.filter((l) => l !== value) });
      break;
    }
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
    case 'add-avoid-repo': {
      // Same owner/repo shape as exclude-repo, but no cleanupExcludedData
      // call: avoidRepos is a soft ranking penalty, not a hard exclusion,
      // so tracked data for the repo stays intact (#1464).
      const parts = value.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format "${value}". Use "owner/repo" format.`);
      }
      const currentAvoid = currentConfig.avoidRepos ?? [];
      const valueLower = value.toLowerCase();
      if (!currentAvoid.some((r) => r.toLowerCase() === valueLower)) {
        stateManager.updateConfig({ avoidRepos: [...currentAvoid, value] });
      }
      break;
    }
    case 'remove-avoid-repo': {
      const currentAvoid = currentConfig.avoidRepos ?? [];
      const valueLower = value.toLowerCase();
      if (!currentAvoid.some((r) => r.toLowerCase() === valueLower)) {
        throw new Error(
          `Repo "${value}" is not on the avoid list. Current avoid list: ${currentAvoid.join(', ') || '(empty)'}`,
        );
      }
      stateManager.updateConfig({ avoidRepos: currentAvoid.filter((r) => r.toLowerCase() !== valueLower) });
      break;
    }
    case 'add-boost-issue-type': {
      // Scout matches boostIssueTypes against issue labels case-insensitively,
      // so the duplicate check is case-insensitive too (#1464).
      const currentTypes = currentConfig.boostIssueTypes ?? [];
      const valueLower = value.toLowerCase();
      if (!currentTypes.some((t) => t.toLowerCase() === valueLower)) {
        stateManager.updateConfig({ boostIssueTypes: [...currentTypes, value] });
      }
      break;
    }
    case 'remove-boost-issue-type': {
      const currentTypes = currentConfig.boostIssueTypes ?? [];
      const valueLower = value.toLowerCase();
      if (!currentTypes.some((t) => t.toLowerCase() === valueLower)) {
        throw new Error(
          `Issue type "${value}" is not on the boost list. Current boost list: ${currentTypes.join(', ') || '(empty)'}`,
        );
      }
      stateManager.updateConfig({ boostIssueTypes: currentTypes.filter((t) => t.toLowerCase() !== valueLower) });
      break;
    }
    case 'issueListPath': {
      stateManager.updateConfig({ issueListPath: value || undefined });
      break;
    }
    case 'diffTool': {
      if (!(DIFF_TOOLS as readonly string[]).includes(value)) {
        throw new Error(`Invalid diffTool "${value}". Valid options: ${DIFF_TOOLS.join(', ')}`);
      }
      stateManager.updateConfig({ diffTool: value as DiffTool });
      break;
    }
    case 'diffToolCustomCommand': {
      stateManager.updateConfig({
        diffToolCustomCommand: value || undefined,
      });
      break;
    }
    default: {
      throw new ValidationError(formatUnknownKeyError(options.key, 'config'));
    }
  }

  return { success: true, key: options.key, value };
}
