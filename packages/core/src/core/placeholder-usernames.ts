/**
 * Known placeholder values that can end up in `config.githubUsername` from
 * doc snippets, example configs, or aborted setup flows.
 *
 * Two callers consult this list:
 *   - `pr-monitor.ts` — runtime auto-repair: if a fetch is about to run with
 *     a placeholder, the configured value is replaced with the authenticated
 *     viewer's login before the search hits GitHub. Without this, the search
 *     silently returns zero results and the dashboard looks like a fresh install.
 *   - `commands/validation.ts` — write-side rejection: prevents `init`,
 *     `setup --set username=`, and the MCP `config` tool from persisting one
 *     of these values in the first place, so the auto-repair only runs as a
 *     fallback for legacy state rather than masking a fresh user error.
 *
 * Entries must be lowercase — `Lowercase<string>` on the source tuple makes a
 * non-lowercase entry a compile error, keeping the case-insensitive lookup
 * contract type-checked instead of comment-documented.
 */
const PLACEHOLDER_USERNAMES: readonly Lowercase<string>[] = [
  'example-user',
  'your-username',
  'your-github-username',
] as const;

const KNOWN_PLACEHOLDER_USERNAMES: ReadonlySet<string> = new Set(PLACEHOLDER_USERNAMES);

export function isPlaceholderUsername(username: string): boolean {
  return KNOWN_PLACEHOLDER_USERNAMES.has(username.toLowerCase());
}
