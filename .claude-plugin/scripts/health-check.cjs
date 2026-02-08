// Quick PR health check — reads cached state, outputs a one-liner if PRs need attention.
// Called by SessionStart hook. Exits silently when nothing actionable.
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
    const need = state.lastDigest.summary.totalNeedingAttention || 0;
    const total = state.lastDigest.summary.totalActivePRs || 0;
    if (need > 0) {
      console.log('OSS: ' + need + ' of ' + total + ' PRs need attention (' + ageLabel + '). Run /oss to address.');
    }
  }
} catch (e) {
  // Silent — don't disrupt session start
}
