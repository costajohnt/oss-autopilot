# @oss-autopilot/badge-endpoint

Shields.io badge endpoint for OSS contribution stats. Only counts PRs to external repos (excludes your own) with 50+ stars by default.

## Usage

Add to your GitHub profile README:

```markdown
![OSS Contributions](https://img.shields.io/endpoint?url=https://oss-autopilot-stats.vercel.app/api/badge/YOUR_USERNAME)
```

### Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minStars` | `50` | Minimum repo star count to include |

```markdown
![OSS Contributions](https://img.shields.io/endpoint?url=https://oss-autopilot-stats.vercel.app/api/badge/YOUR_USERNAME?minStars=100)
```

### What it shows

- **Merge rate** — merged / (merged + closed without merge)
- **Merged count** — total merged PRs to qualifying external repos
- **Open count** — currently open PRs to qualifying external repos

### Caching

- Vercel CDN: 1 hour (`s-maxage=3600`)
- In-memory badge cache: 1 hour
- Repo star cache: 24 hours

## Development

```bash
pnpm install
vercel dev
```

## Deploy

```bash
vercel --prod
```

## SVG Widgets

Three SVG widget endpoints render live contribution data directly in any Markdown surface that displays images (GitHub profile READMEs, issue comments, wikis, etc.).

### Stats Card

Shows merged PR count, merge rate, repo count, and current streak.

```markdown
[![OSS Contributions](https://oss-autopilot-stats.vercel.app/api/card/YOUR_USERNAME)](https://github.com/costajohnt/oss-autopilot)
```

### Recent Contributions

Shows your five most recently merged PRs.

```markdown
![Recent](https://oss-autopilot-stats.vercel.app/api/recent/YOUR_USERNAME)
```

### Activity Graph

Shows a 26-week contribution heatmap.

```markdown
![Activity](https://oss-autopilot-stats.vercel.app/api/activity/YOUR_USERNAME)
```

### Options

| Parameter | Values | Description |
|-----------|--------|-------------|
| `theme` | `light` (default), `dark` | Color scheme |
| `cache` | `no` | Bypass the 1-hour in-memory cache |

### Dark Theme Example

```markdown
[![OSS Contributions](https://oss-autopilot-stats.vercel.app/api/card/YOUR_USERNAME?theme=dark)](https://github.com/costajohnt/oss-autopilot)
![Recent](https://oss-autopilot-stats.vercel.app/api/recent/YOUR_USERNAME?theme=dark)
![Activity](https://oss-autopilot-stats.vercel.app/api/activity/YOUR_USERNAME?theme=dark)
```
