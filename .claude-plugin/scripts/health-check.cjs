/**
 * Quick PR health check — reads cached state, outputs a one-liner summary.
 *
 * Trigger: Called by the SessionStart hook (hooks/session-start.sh, step 3).
 * The hook captures stdout and includes it in the session's additionalContext.
 *
 * Behavior:
 * - Reads ~/.oss-autopilot/state.json (cached from last /oss run)
 * - If showHealthCheck is false in config, exits silently
 * - If no state exists, shows a first-run hint to run /oss
 * - If last digest is >7 days old, nudges the user to catch up
 * - Otherwise, outputs a compact one-liner: "OSS: 15 active PRs — 1 need response, 5 awaiting re-review (2h ago)"
 *
 * Configuration: Set showHealthCheck to false to disable:
 *   node packages/core/dist/cli.bundle.cjs setup --set showHealthCheck=false
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
  if (state.config && state.config.showHealthCheck === false) process.exit(0);
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
  if (ageDays > 7) {
    console.log("OSS: Haven't checked your PRs in " + ageDays + ' days. Run /oss to catch up.');
  } else {
    const d = state.lastDigest;
    const total = d.summary.totalActivePRs || 0;
    if (total === 0) process.exit(0);
    // Build status segments for a compact one-liner
    const segments = [];
    const needResponse = (d.prsNeedingResponse || []).length;
    const ciFailing = (d.ciFailingPRs || []).length;
    const conflicts = (d.mergeConflictPRs || []).length;
    const needsChanges = (d.needsChangesPRs || []).length;
    const addressed = (d.changesAddressedPRs || []).length;
    const waitMaintainer = (d.waitingOnMaintainerPRs || []).length;
    // Actionable items first (you need to do something)
    if (needResponse > 0) segments.push(needResponse + ' need response');
    if (needsChanges > 0) segments.push(needsChanges + ' need changes');
    if (ciFailing > 0) segments.push(ciFailing + ' CI failing');
    if (conflicts > 0) segments.push(conflicts + ' conflicts');
    // Informational items (waiting on others)
    if (addressed > 0) segments.push(addressed + ' awaiting re-review');
    if (waitMaintainer > 0) segments.push(waitMaintainer + ' waiting on maintainer');
    if (segments.length > 0) {
      console.log('OSS: ' + total + ' active PRs — ' + segments.join(', ') + ' (' + ageLabel + ')');
    } else {
      console.log('OSS: ' + total + ' active PRs, all healthy (' + ageLabel + ')');
    }
  }
} catch (e) {
  // Log to stderr for debugging, but don't disrupt session start
  process.stderr.write('oss-autopilot health-check: ' + (e.message || e) + '\n');
}
