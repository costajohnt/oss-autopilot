# @oss-autopilot/dashboard

Interactive dashboard SPA for [OSS Autopilot](https://github.com/costajohnt/oss-autopilot) — a Preact + Vite single-page app that visualizes the contributor's active PRs, merged history, and pursue-queue.

> This package is **private** (not published to npm). It builds a static bundle that `@oss-autopilot/core` serves from its `dashboard serve` command.

## How it fits

```
┌──────────────────────────────────────────────────────┐
│  Browser                                             │
│  ┌────────────────────────────────────────────┐      │
│  │ @oss-autopilot/dashboard  (Preact SPA)     │      │
│  │  • Chart.js visualizations                 │      │
│  │  • Celebration toast hook                  │      │
│  │  • Dark theme toggle                       │      │
│  └────────────────────────────────────────────┘      │
│                    │  fetch /api/data                │
│                    ▼                                 │
│  ┌────────────────────────────────────────────┐      │
│  │ dashboard-server.ts  (in @oss-autopilot/core)     │
│  │  • serves built dist/ as static assets     │      │
│  │  • returns DashboardJsonData on /api/data  │      │
│  │  • accepts POST /api/action for mutations  │      │
│  └────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────┘
```

The runtime contract (`DashboardJsonData`) is single-sourced in [`@oss-autopilot/core/commands/dashboard-data.ts`](../core/src/commands/dashboard-data.ts); the dashboard imports it via `@oss-autopilot/core/types` rather than redeclaring.

## Develop

```bash
# From the repo root:
pnpm install
pnpm dashboard:dev    # Vite dev server on http://localhost:5173
```

The dev server talks to a running `oss-autopilot dashboard serve` (or uses mock data via `import.meta.env.DEV` branches in `src/hooks/use-dashboard.ts`).

## Build

```bash
pnpm dashboard:build  # outputs packages/dashboard/dist/
```

`@oss-autopilot/core/commands/dashboard-server.ts` path-resolves this `dist/` directory at runtime.

## Test

```bash
pnpm --filter @oss-autopilot/dashboard test         # one-shot
pnpm --filter @oss-autopilot/dashboard test:watch   # watch mode
```

Tests use `vitest` + `@testing-library/preact` + `jsdom`, with `.test.` files co-located next to the modules they cover. Run the suite above for the current totals (see root [README](../../README.md#by-the-numbers) for the full project totals).

## File layout

| Path | Purpose |
|---|---|
| `src/app.tsx` | Root component + route shell |
| `src/components/` | Visualization components (charts, cards, tables) |
| `src/hooks/use-dashboard.ts` | `/api/data` fetcher + polling |
| `src/hooks/use-theme.ts` | Dark-theme toggle with `localStorage` persistence |
| `src/hooks/use-celebration.ts` | Celebration toast on newly-merged PRs (confetti) |
| `src/types.ts` | Dashboard-side types (imports shared types from core) |
| `vite.config.ts` | Vite + Preact plugin config |

## Why a separate package?

The dashboard is kept in its own workspace package so its Vite/Preact toolchain doesn't bleed into the CLI bundle, and so its test run can be parallelized by vitest across the three packages. It is deliberately not published to npm — the built artifact is consumed at runtime via filesystem path detection from the core package.

## See also

- Root [README](../../README.md) — installation, positioning, and feature overview
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — three-layer architecture
- [`@oss-autopilot/core` README](../core/README.md) — CLI and core library
- [`@oss-autopilot/mcp` README](../mcp-server/README.md) — MCP server
