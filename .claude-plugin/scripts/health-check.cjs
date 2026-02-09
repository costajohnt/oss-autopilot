// Quick PR health check — reads cached state, outputs a one-liner summary.
// Called by SessionStart hook. Exits silently only when no PRs are tracked.
try {
  const s = require('fs').readFileSync(
    require('path').join(require('os').homedir(), '.oss-autopilot', 'state.json'),
    'utf8'
  );
  const state = JSON.parse(s);
  if (state.config && state.config.showHealthCheck === false) process.exit(0);
  const lastRun = state.lastDigestAt || state.lastRunAt;
  if (!lastRun || !state.lastDigest) process.exit(0);
  const ageMs = Date.now() - new Date(lastRun).getTime();
  const ageDays = Math.floor(ageMs / 86400000);
  const ageHours = Math.floor(ageMs / 3600000);
  const ageLabel = ageDays >= 1 ? ageDays + 'd ago' : ageHours + 'h ago';
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
  // Silent — don't disrupt session start
}
