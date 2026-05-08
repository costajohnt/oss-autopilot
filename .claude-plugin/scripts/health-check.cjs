/**
 * Quick PR health check — reads cached state, outputs a one-liner summary.
 *
 * Trigger: Called by the SessionStart hook (hooks/session-start.sh, step 3).
 * The hook captures stdout and includes it in the session's additionalContext.
 *
 * Behavior:
 * - Reads ~/.oss-autopilot/state.json (cached from last /oss run)
 * - If no state exists, shows a first-run hint to run /oss
 * - If last digest is >7 days old, nudges the user to catch up
 * - If the cached digest is older than the freshness threshold (default
 *   30 minutes, configurable via `config.healthCheckFreshnessMinutes`),
 *   suppress the line entirely so the user only sees it when current (#1255)
 * - Otherwise, outputs a compact one-liner: "OSS: 15 active PRs — 3 need addressing, 12 waiting on maintainer (2h ago)"
 *
 * Error handling: Errors are logged to stderr (visible in debug) but never
 * disrupt session start — the hook always exits cleanly.
 */
try {
  const statePath = require('path').join(require('os').homedir(), '.oss-autopilot', 'state.json');
  let s;
  try {
    s = require('fs').readFileSync(statePath, 'utf8');
  } catch (readErr) {
    // State file doesn't exist — user hasn't run /oss yet
    console.log('OSS: No PR data yet. Run /oss to get started.');
    process.exit(0);
  }
  const state = JSON.parse(s);
  const lastRun = state.lastDigestAt || state.lastRunAt;
  if (!lastRun || !state.lastDigest) {
    console.log('OSS: No PR data yet. Run /oss to get started.');
    process.exit(0);
  }
  const ageMs = Date.now() - new Date(lastRun).getTime();
  const ageDays = Math.floor(ageMs / 86400000);
  const ageHours = Math.floor(ageMs / 3600000);
  const ageMinutes = Math.floor(ageMs / 60000);
  const ageLabel = ageDays >= 1 ? ageDays + 'd ago' : ageHours >= 1 ? ageHours + 'h ago' : ageMinutes + 'm ago';
  // Freshness gate (#1255). The cached digest only refreshes on `/oss`;
  // SessionStart fires every session, so without this gate the line drifts
  // arbitrarily stale. Suppress when older than the configured minute
  // budget (default 30) but younger than the 7-day catch-up nudge.
  const freshnessMinutes =
    typeof state.config === 'object' && state.config !== null && Number.isInteger(state.config.healthCheckFreshnessMinutes)
      ? state.config.healthCheckFreshnessMinutes
      : 30;
  const freshThresholdMs = freshnessMinutes * 60 * 1000;
  if (ageMs > freshThresholdMs && ageDays <= 7) {
    process.exit(0);
  }
  if (ageDays > 7) {
    console.log("OSS: Haven't checked your PRs in " + ageDays + ' days. Run /oss to catch up.');
  } else {
    const d = state.lastDigest;
    const total = d.summary.totalActivePRs || 0;
    if (total === 0) process.exit(0);
    // Build status segments for a compact one-liner
    // Filter out shelved PRs so breakdown counts match totalActivePRs (#674)
    const shelvedUrls = new Set((d.shelvedPRs || []).map(function(p) { return p.url; }));
    const segments = [];
    const needsAddressing = (d.needsAddressingPRs || []).filter(function(p) { return !shelvedUrls.has(p.url); }).length;
    const waitMaintainer = (d.waitingOnMaintainerPRs || []).filter(function(p) { return !shelvedUrls.has(p.url); }).length;
    // Actionable items first (you need to do something)
    if (needsAddressing > 0) segments.push(needsAddressing + ' need addressing');
    // Informational items (waiting on others)
    if (waitMaintainer > 0) segments.push(waitMaintainer + ' waiting on maintainer');
    if (segments.length > 0) {
      console.log('OSS: ' + total + ' active PRs — ' + segments.join(', ') + ' (' + ageLabel + ')');
    } else {
      console.log('OSS: ' + total + ' active PRs, all on track (' + ageLabel + ')');
    }
  }
} catch (e) {
  // Log to stderr for debugging, but don't disrupt session start
  process.stderr.write('oss-autopilot health-check: ' + (e.message || e) + '\n');
}
