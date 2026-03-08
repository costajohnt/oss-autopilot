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
