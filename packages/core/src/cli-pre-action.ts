/**
 * The CLI's preAction hook: debug flag, auth gate, and Gist persistence
 * bootstrap. Lives outside cli.ts because cli.ts parses argv and may call
 * process.exit at import time, so nothing in it can be imported by a test.
 * Tests previously exercised a hand-copied replica of this hook, which drifted.
 */

import type { Command } from 'commander';
import { getGitHubTokenAsync, enableDebug, debug } from './core/index.js';

/** Install the preAction hook. `localOnlySet` holds the registry names that skip the auth gate. */
export function installPreAction(program: Command, localOnlySet: ReadonlySet<string>): void {
  program.hook('preAction', async (thisCommand, actionCommand) => {
    // Enable debug logging if --debug flag is set
    const globalOpts = thisCommand.opts();
    if (globalOpts.debug) {
      enableDebug();
      debug('cli', `Running command: ${actionCommand.name()}`);
    }

    // actionCommand is the command being executed (e.g., 'status', 'daily').
    // For subcommand groups (e.g. `guidelines view`), Commander returns the
    // leaf name `view` — but the registry sets `localOnly` on the parent
    // entry `guidelines`. Walk the parent chain so a `localOnly` ancestor
    // covers all its leaves (#1208 M2). Without this, `guidelines view` —
    // which works fine in local mode (returns storageMode: 'local-unavailable')
    // — would still hit the auth gate and fail.
    let cmd: typeof actionCommand | null = actionCommand;
    let isLocalOnly = false;
    while (cmd) {
      if (localOnlySet.has(cmd.name())) {
        isLocalOnly = true;
        break;
      }
      cmd = cmd.parent;
    }

    if (!isLocalOnly) {
      const token = await getGitHubTokenAsync();
      if (!token) {
        // Honor --json at the CLI boundary so machine consumers (plugins, MCP
        // stdio harnesses, scripts) get a parseable envelope instead of a
        // stderr blob followed by a non-zero exit. Commander has already parsed
        // the action's own options, so we check both the action command and the
        // raw argv as a fallback (#1056 M20).
        const wantsJson = Boolean(actionCommand.opts().json) || process.argv.includes('--json');
        if (wantsJson) {
          const { outputJsonError } = await import('./formatters/json.js');
          outputJsonError(
            'GitHub authentication required. Install gh CLI and run `gh auth login`, or set GITHUB_TOKEN.',
            'AUTH_REQUIRED',
          );
        } else {
          console.error('Error: GitHub authentication required.');
          console.error('');
          console.error('Option 1 (Recommended): Install and authenticate GitHub CLI');
          console.error('  Install: https://cli.github.com/');
          console.error('  Then run: gh auth login');
          console.error('');
          console.error('Option 2: Set GITHUB_TOKEN environment variable');
          console.error('  export GITHUB_TOKEN="your-github-token-here"');
          console.error('');
          console.error('Then run your command again.');
        }
        process.exit(1);
      }

      // Activate Gist persistence if configured, before any command runs.
      // Shared helper peeks at the state file and only pre-sets the singleton
      // when Gist mode is the configured persistence (#1000). Hard errors
      // still throw (#1202); the resolving degraded modes are surfaced in the
      // JSON envelope so --json consumers see them too (#1433).
      const { ensureGistPersistence, renderGistWarning } = await import('./core/index.js');
      const status = await ensureGistPersistence(token);
      if (status === 'degraded' || status === 'state-unreadable') {
        const { setEnvelopeGistWarning } = await import('./formatters/json.js');
        // Shared renderer (#1444). 'degraded' is ensureGistPersistence's
        // deliberate conflation of the transient init fallback and a #1443
        // degraded bootstrap — rendered as the init-fallback cause, as before.
        setEnvelopeGistWarning(renderGistWarning(status === 'degraded' ? 'init-fallback' : 'state-unreadable'));
      }
    } else {
      // #1431: localOnly skips the AUTH GATE, not gist persistence. Mutating
      // localOnly commands (shelve/move/dismiss/override/...) already call
      // maybeCheckpoint, which silently no-ops when the singleton never
      // bootstrapped — so a gist-configured user's CLI mutations were written
      // local-only with no warning and never reached the Gist. Best-effort
      // bootstrap; the warning semantics live (and are unit-tested) in
      // bootstrapGistBestEffort.
      const { bootstrapGistBestEffort } = await import('./core/index.js');
      const localOnlyWarning = await bootstrapGistBestEffort(getGitHubTokenAsync);
      if (localOnlyWarning) {
        console.error(`Warning: ${localOnlyWarning}`);
        // Also thread it into the JSON envelope: shelve/move/dismiss --json
        // consumers (the agent harness) must see the mutation will not sync —
        // stderr alone is invisible to them (#1433).
        const { setEnvelopeGistWarning } = await import('./formatters/json.js');
        setEnvelopeGistWarning(localOnlyWarning);
      }
    }
  });
}
