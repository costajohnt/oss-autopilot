# Demo GIF Recording Guide

How to record a demo GIF/video for the OSS Autopilot README.

## Recommended Tools

- **[asciinema](https://asciinema.org/)** — terminal recording (can convert to GIF with [agg](https://github.com/asciinema/agg))
- **[Kap](https://getkap.co/)** — macOS screen recorder with GIF export
- **[CleanShot X](https://cleanshot.com/)** — macOS screenshot/recording tool

## Terminal Setup

- Resolution: **120 columns x 30 rows** (`stty cols 120 rows 30`)
- Font size: **14pt or larger** (readable at 800px wide)
- Theme: **dark background** (matches most README viewers)
- Clear scrollback before recording

## Recording Script (15-20 seconds)

| Time | Action | Notes |
|------|--------|-------|
| 0-1s | Clean terminal with Claude Code running | Start with a fresh prompt |
| 1-3s | Type `/oss` and press Enter | The "invocation moment" |
| 3-6s | CLI fetches PRs (brief loading) | Shows real GitHub integration |
| 6-11s | PR summary output with statuses | **Hold here — this is the wow moment** |
| 11-14s | AskUserQuestion action prompt appears | Shows the interactive workflow |
| 14-16s | Select "Address all issues in parallel" | Demonstrates the power action |
| 16-18s | Agents being dispatched | Shows parallelism |

## Shorter Version (10 seconds)

For a more focused GIF, record just steps 1-5 (the summary output is the hook):

| Time | Action |
|------|--------|
| 0-1s | Clean terminal |
| 1-3s | Type `/oss` and press Enter |
| 3-5s | Loading |
| 5-10s | PR summary output — hold to let viewer read |

## Tips

- **Trim dead time** — cut pauses where nothing happens
- **Pre-populate state** — run `/oss` once before recording so cached data makes the demo faster
- **Use real data** — a demo with actual PR names and repos is more convincing than fake data
- **File size** — keep the GIF under 5MB for fast README loading; use lossy compression if needed
- **Alt text** — when adding to README, use descriptive alt text: `![Demo: running /oss to check PR health and take action](docs/images/demo.gif)`

## Adding to README

Once recorded, place the file at `docs/images/demo.gif` and replace the placeholder in `README.md`:

```markdown
![Demo: running /oss to check PR health and take action](docs/images/demo.gif)
```
