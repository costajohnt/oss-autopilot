/**
 * Runtime schema for the dashboard server's `GET /api/data` response (#1050).
 *
 * The server (`commands/dashboard-data.ts`) and client (`packages/dashboard/`)
 * run in different processes. TypeScript can't cross the process boundary —
 * if the server removes or renames a field, the client hits runtime
 * `undefined` with no diagnostic. This schema is the shared runtime contract:
 * the server can optionally self-check outgoing payloads, and the dashboard
 * validates every `/api/data` response before committing to state.
 *
 * Intentional scope: this schema validates **top-level presence and primitive
 * shape** (required vs optional fields, container types like array/object),
 * but uses `z.array(z.unknown())` for nested PR/issue arrays rather than
 * pinning every field. The top-level surface is the only place drift tends
 * to go silently undetected — nested fields already blow up loudly at the
 * render site when they change. Exhaustive nested validation would turn the
 * schema into a maintenance burden.
 */

import { z } from 'zod';

export const DashboardStatsSchema = z.object({
  activePRs: z.number(),
  shelvedPRs: z.number(),
  mergedPRs: z.number(),
  closedPRs: z.number(),
  mergeRate: z.string(),
  availableIssues: z.number().optional(),
});

const RepoStatsEntrySchema = z.object({
  active: z.number(),
  merged: z.number(),
  closed: z.number(),
});

const TopRepoSchema = z.object({
  repo: z.string(),
  active: z.number(),
  merged: z.number(),
  closed: z.number(),
});

export const DashboardDataSchema = z.object({
  stats: DashboardStatsSchema,
  prsByRepo: z.record(z.string(), RepoStatsEntrySchema),
  topRepos: z.array(TopRepoSchema),
  monthlyMerged: z.record(z.string(), z.number()),
  monthlyOpened: z.record(z.string(), z.number()),
  monthlyClosed: z.record(z.string(), z.number()),
  // PR / issue arrays are validated loosely — the domain shapes are pinned by
  // AgentStateSchema (state-schema.ts) on the server side. Use `z.unknown()`
  // here so server-side additions to the nested shape don't break the
  // dashboard's parse; the UI handles unknown extra fields gracefully.
  activePRs: z.array(z.unknown()),
  shelvedPRUrls: z.array(z.string()),
  recentlyMergedPRs: z.array(z.unknown()),
  recentlyClosedPRs: z.array(z.unknown()),
  autoUnshelvedPRs: z.array(z.unknown()),
  commentedIssues: z.array(z.unknown()),
  issueResponses: z.array(z.unknown()),
  allMergedPRs: z.array(z.unknown()),
  allClosedPRs: z.array(z.unknown()),
  repoMetadata: z.record(z.string(), z.unknown()).optional(),
  vettedIssues: z.unknown().nullable().optional(),
  offline: z.boolean().optional(),
  lastUpdated: z.string().optional(),
  partialFailures: z.array(z.string()).optional(),
});

export type DashboardDataParsed = z.infer<typeof DashboardDataSchema>;

/**
 * Validate a raw `/api/data` payload. Returns `{ok: true, data}` on success or
 * `{ok: false, message}` with a condensed Zod error string on failure. Never
 * throws. The dashboard's `useDashboard` hook surfaces the message in the UI.
 */
export function validateDashboardData(
  raw: unknown,
): { ok: true; data: DashboardDataParsed } | { ok: false; message: string } {
  const result = DashboardDataSchema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const issues = result.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  const more = result.error.issues.length > 3 ? ` (+${result.error.issues.length - 3} more)` : '';
  return { ok: false, message: `Server response did not match expected shape — ${issues}${more}` };
}
