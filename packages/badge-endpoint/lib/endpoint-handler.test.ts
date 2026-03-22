import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWidgetHandler } from './endpoint-handler.js';
import type { ContributionData } from './github-data.js';

// Hoist mock references so they're available inside vi.mock factory
const { fetchMock } = vi.hoisted(() => {
  const fetchMock = vi.fn();
  return { fetchMock };
});

vi.mock('./github-data.js', () => {
  return {
    fetchContributionData: fetchMock,
    isValidUsername: (username: string) => /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(username),
  };
});

/** Minimal fake ContributionData for happy-path tests. */
function makeData(overrides: Partial<ContributionData> = {}): ContributionData {
  return {
    merged: 10,
    open: 2,
    closedUnmerged: 1,
    mergeRate: 90,
    repoCount: 3,
    recentPRs: [],
    cappedMerged: false,
    cappedClosedUnmerged: false,
    dailyActivity: {},
    streak: 0,
    ...overrides,
  };
}

/** Build a simple mock VercelRequest. */
function makeReq(query: Record<string, string>): any {
  return { query };
}

/** Build a mock VercelResponse that records the last status code and body sent. */
function makeRes() {
  const res: any = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
  };

  res.setHeader = (name: string, value: string) => {
    res._headers[name] = value;
    return res;
  };

  res.status = (code: number) => {
    res._status = code;
    return res;
  };

  res.send = (body: string) => {
    res._body = body;
    return res;
  };

  return res;
}

const BASE_CONFIG = {
  prefix: 'test',
  errorWidth: 400,
  errorHeight: 80,
  errorTextY: 46,
  render: vi.fn((_data: ContributionData, _mode: 'light' | 'dark') => '<svg>widget</svg>'),
};

describe('createWidgetHandler', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'fake-token';
    BASE_CONFIG.render.mockImplementation(() => '<svg>widget</svg>');
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('returns 200 with rendered SVG for a valid request', async () => {
    fetchMock.mockResolvedValueOnce(makeData());
    const handler = createWidgetHandler(BASE_CONFIG);
    const req = makeReq({ username: 'costajohnt' });
    const res = makeRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledWith('costajohnt', 'fake-token');
    expect(BASE_CONFIG.render).toHaveBeenCalledOnce();
    expect(res._status).toBe(200);
    expect(res._body).toBe('<svg>widget</svg>');
  });

  it('returns 400 with error SVG for an invalid username', async () => {
    const handler = createWidgetHandler(BASE_CONFIG);
    const req = makeReq({ username: '-bad-user' });
    const res = makeRes();

    await handler(req, res);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect(res._body).toContain('<svg');
    expect(res._body).toContain('Invalid GitHub username');
  });

  it('returns 500 with error SVG when GITHUB_TOKEN is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    const handler = createWidgetHandler(BASE_CONFIG);
    const req = makeReq({ username: 'costajohnt' });
    const res = makeRes();

    await handler(req, res);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res._status).toBe(500);
    expect(res._body).toContain('missing GitHub token');
  });

  it('returns cached SVG on second call within TTL without re-fetching', async () => {
    fetchMock.mockResolvedValue(makeData());
    const handler = createWidgetHandler(BASE_CONFIG);
    const req = makeReq({ username: 'costajohnt' });

    const res1 = makeRes();
    await handler(req, res1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res1._status).toBe(200);

    const res2 = makeRes();
    await handler(req, res2);
    // Should not have fetched again — served from cache
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res2._status).toBe(200);
    expect(res2._body).toBe(res1._body);
  });

  it('bypasses cache when cache=no is set', async () => {
    fetchMock.mockResolvedValue(makeData());
    const handler = createWidgetHandler(BASE_CONFIG);

    const res1 = makeRes();
    await handler(makeReq({ username: 'costajohnt' }), res1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const res2 = makeRes();
    await handler(makeReq({ username: 'costajohnt', cache: 'no' }), res2);
    // Cache bypassed — should fetch again
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res2._status).toBe(200);
  });

  it('returns 404 for user_not_found error', async () => {
    fetchMock.mockResolvedValueOnce({ error: 'user_not_found' });
    const handler = createWidgetHandler(BASE_CONFIG);
    const res = makeRes();

    await handler(makeReq({ username: 'costajohnt' }), res);

    expect(res._status).toBe(404);
    expect(res._body).toContain('<svg');
    expect(res._body).toContain('not found');
  });

  it('returns 429 for rate_limited error', async () => {
    fetchMock.mockResolvedValueOnce({ error: 'rate_limited' });
    const handler = createWidgetHandler(BASE_CONFIG);
    const res = makeRes();

    await handler(makeReq({ username: 'costajohnt' }), res);

    expect(res._status).toBe(429);
    expect(res._body).toContain('<svg');
    expect(res._body).toContain('rate limit');
  });

  it('returns 502 for api_error', async () => {
    fetchMock.mockResolvedValueOnce({ error: 'api_error' });
    const handler = createWidgetHandler(BASE_CONFIG);
    const res = makeRes();

    await handler(makeReq({ username: 'costajohnt' }), res);

    expect(res._status).toBe(502);
    expect(res._body).toContain('<svg');
    expect(res._body).toContain('GitHub API error');
  });

  it('returns 500 with error SVG when render throws', async () => {
    fetchMock.mockResolvedValueOnce(makeData());
    BASE_CONFIG.render.mockImplementationOnce(() => {
      throw new Error('render boom');
    });
    const handler = createWidgetHandler(BASE_CONFIG);
    const res = makeRes();

    await handler(makeReq({ username: 'costajohnt' }), res);

    expect(res._status).toBe(500);
    expect(res._body).toContain('<svg');
    expect(res._body).toContain('Render error');
  });

  it('serves stale cache when past CACHE_TTL but within STALE_TTL and fetch fails', async () => {
    const CACHE_TTL = 60 * 60 * 1000; // 1 hour

    // First request — populate the cache
    fetchMock.mockResolvedValueOnce(makeData());
    const handler = createWidgetHandler(BASE_CONFIG);
    const res1 = makeRes();
    await handler(makeReq({ username: 'costajohnt' }), res1);
    expect(res1._status).toBe(200);
    const cachedSvg = res1._body;

    // Advance time past CACHE_TTL (1h) but still within STALE_TTL (24h)
    const realNow = Date.now();
    const advancedTime = realNow + CACHE_TTL + 5000; // 1h + 5s
    vi.spyOn(Date, 'now').mockReturnValue(advancedTime);

    // Fetch now returns an error
    fetchMock.mockResolvedValueOnce({ error: 'api_error' as const });

    const res2 = makeRes();
    await handler(makeReq({ username: 'costajohnt' }), res2);

    // Should fall back to stale cache and return 200 with the same SVG
    expect(res2._status).toBe(200);
    expect(res2._body).toBe(cachedSvg);

    vi.restoreAllMocks();
  });
});
