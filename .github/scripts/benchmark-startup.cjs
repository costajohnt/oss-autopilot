// Benchmark CLI startup time by running --help 5 times and printing the median.
// Used by both the CI and update-badge jobs in ci.yml.
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const times = [];
for (let i = 0; i < 5; i++) {
  try {
    const start = performance.now();
    execFileSync('node', ['packages/core/dist/cli.bundle.cjs', '--help'], {
      stdio: 'pipe',
    });
    times.push(performance.now() - start);
  } catch (e) {
    const detail = e.stderr ? e.stderr.toString().trim() : e.message;
    process.stderr.write(`Benchmark iteration ${i} failed: ${detail}\n`);
  }
}
if (times.length < 3) {
  process.stderr.write(
    `Too few successful iterations (${times.length}/5). Aborting benchmark.\n`,
  );
  process.exit(1);
}
times.sort((a, b) => a - b);
console.log(Math.round(times[Math.floor(times.length / 2)]));
