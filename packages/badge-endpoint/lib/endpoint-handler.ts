import type { IncomingMessage, ServerResponse } from 'http';
import { fetchContributionData, isValidUsername, type ContributionData } from './github-data.js';

/** Minimal Vercel request/response types (avoids heavy @vercel/node devDependency). */
interface VercelRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
}
interface VercelResponse extends ServerResponse {
  status(code: number): VercelResponse;
  send(body: string): VercelResponse;
  setHeader(name: string, value: string | string[]): VercelResponse;
}

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const STALE_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  svg: string;
  ts: number;
}

export interface WidgetHandlerConfig {
  /** Short name used for the per-widget in-memory cache key namespace. */
  prefix: string;
  errorWidth: number;
  errorHeight: number;
  errorTextY: number;
  render: (data: ContributionData, mode: 'light' | 'dark') => string;
}

function makeErrorSvg(message: string, mode: 'light' | 'dark', width: number, height: number, textY: number): string {
  const bg = mode === 'dark' ? '#0d1117' : '#ffffff';
  const text = mode === 'dark' ? '#e6edf3' : '#1e293b';
  const border = mode === 'dark' ? '#30363d' : '#e2e8f0';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  <rect width="${width}" height="${height}" rx="8" fill="${bg}" stroke="${border}" stroke-width="1"/>
  <text x="${Math.round(width / 2)}" y="${textY}" font-family="system-ui,sans-serif" font-size="13" fill="${text}" text-anchor="middle">${message}</text>
</svg>`;
}

export function createWidgetHandler(config: WidgetHandlerConfig) {
  const { prefix, errorWidth, errorHeight, errorTextY, render } = config;
  const cache = new Map<string, CacheEntry>();

  function errorSvg(message: string, mode: 'light' | 'dark'): string {
    return makeErrorSvg(message, mode, errorWidth, errorHeight, errorTextY);
  }

  return async function handler(req: VercelRequest, res: VercelResponse) {
    const { username, theme: themeParam, cache: cacheParam } = req.query;

    const mode: 'light' | 'dark' = themeParam === 'dark' ? 'dark' : 'light';
    const noCache = cacheParam === 'no';

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');

    if (typeof username !== 'string' || !isValidUsername(username)) {
      return res.status(400).send(errorSvg('Invalid GitHub username', mode));
    }

    if (!process.env.GITHUB_TOKEN) {
      return res.status(500).send(errorSvg('Server configuration error: missing GitHub token', mode));
    }

    const cacheKey = `${prefix}:${username}:${mode}`;

    if (!noCache) {
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        return res.status(200).send(cached.svg);
      }
    }

    const result = await fetchContributionData(username, process.env.GITHUB_TOKEN);

    if (result.error) {
      // Try stale fallback before returning an error SVG
      const stale = cache.get(cacheKey);
      if (stale && Date.now() - stale.ts < STALE_TTL) {
        return res.status(200).send(stale.svg);
      }

      if (result.error === 'user_not_found') {
        return res.status(404).send(errorSvg(`GitHub user "${username}" not found`, mode));
      }
      if (result.error === 'rate_limited') {
        return res.status(429).send(errorSvg('GitHub API rate limit reached — try again later', mode));
      }
      return res.status(502).send(errorSvg('GitHub API error — try again later', mode));
    }

    const svg = render(result, mode);
    cache.set(cacheKey, { svg, ts: Date.now() });
    return res.status(200).send(svg);
  };
}
