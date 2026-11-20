import { isRateLimitOrAuthError } from './errors.js';

/** Maximum pages to fetch to prevent runaway pagination */
const MAX_PAGES = 10;

/** Result of {@link paginateAllDetailed}: the items plus a truncation signal. */
export interface PaginateAllResult<T> {
  items: T[];
  /**
   * True when the page cap was reached with a full final page — more data
   * may exist on the server beyond what was fetched. GitHub list endpoints
   * return oldest-first, so on truncation it is the NEWEST entries that are
   * missing. Callers should surface this through their warning channel
   * rather than silently presenting a partial view (#1456).
   */
  truncated: boolean;
}

/**
 * Auto-paginate an Octokit list endpoint, reporting whether the page cap
 * truncated the results. Fetches additional pages when the result count
 * equals per_page (indicating more data may exist).
 *
 * @param fetchPage Function that fetches a single page given a page number
 * @param perPage Items per page (default 100)
 * @param maxPages Maximum pages to fetch (default 10 = 1000 items)
 */
export async function paginateAllDetailed<T>(
  fetchPage: (page: number) => Promise<{ data: T[] }>,
  perPage = 100,
  maxPages = MAX_PAGES,
): Promise<PaginateAllResult<T>> {
  const allItems: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await fetchPage(page);
    allItems.push(...data);
    if (data.length < perPage) return { items: allItems, truncated: false }; // No more pages
  }
  // Every fetched page (including the last allowed one) was full — more
  // data may exist beyond the cap.
  return { items: allItems, truncated: true };
}

/**
 * Auto-paginate an Octokit list endpoint. Fetches additional pages when
 * the result count equals per_page (indicating more data may exist).
 *
 * Silently drops anything past `maxPages` — use {@link paginateAllDetailed}
 * when the caller needs to know the results were truncated.
 *
 * @param fetchPage Function that fetches a single page given a page number
 * @param perPage Items per page (default 100)
 * @param maxPages Maximum pages to fetch (default 10 = 1000 items)
 */
export async function paginateAll<T>(
  fetchPage: (page: number) => Promise<{ data: T[] }>,
  perPage = 100,
  maxPages = MAX_PAGES,
): Promise<T[]> {
  const { items } = await paginateAllDetailed(fetchPage, perPage, maxPages);
  return items;
}

/** The part of a Search API response {@link searchAllPages} reads. */
export interface SearchPage<T> {
  total_count: number;
  incomplete_results?: boolean;
  items: T[];
}

/** Result of {@link searchAllPages}. */
export interface SearchPagesResult<T> {
  /** The items of every page read, unique by `html_url`, in the order first seen. */
  items: T[];
  /** `total_count` from the last page read; 0 when none was. */
  totalCount: number;
  /** Pages read successfully. */
  pagesRead: number;
  /** GitHub flagged a page `incomplete_results` (the search timed out server-side and returned what it had). */
  incomplete: boolean;
  /** The page after the first whose request failed, with the error; the pages before it were kept. */
  failure?: { page: number; error: unknown };
  /**
   * True when `items` is not the whole result: a later page failed, GitHub
   * flagged a page incomplete, or fewer unique items were read than
   * `totalCount` (the page cap, or the list shifted between page requests
   * and an item was skipped). Callers must surface this and must not read
   * "absent from the items" as "does not exist" (#1928).
   */
  truncated: boolean;
}

/**
 * Page cap for {@link searchAllPages}. The Search API gets unreliable (500s,
 * ECONNRESET) past page 3 and allows 30 requests a minute, so callers narrow
 * the query rather than raise this.
 */
export const SEARCH_MAX_PAGES = 3;

/** One page, or the error of a later page the search can go on without. */
async function readSearchPage<T>(
  fetchPage: (page: number) => Promise<{ data: SearchPage<T> }>,
  page: number,
): Promise<{ data: SearchPage<T> } | { error: unknown }> {
  try {
    return await fetchPage(page);
  } catch (error) {
    if (page === 1 || isRateLimitOrAuthError(error)) throw error;
    return { error };
  }
}

/**
 * Read a Search API query page by page until every result is read or the
 * page cap is reached. The search is sorted by update time, so an item
 * updated between two page requests can come back on the next page too:
 * items are deduplicated by `html_url`.
 *
 * A page after the first that fails ends the search with the items read so
 * far, `failure` set and `truncated` true; the caller reports it.
 *
 * @param fetchPage Function that fetches a single page given a page number
 * @param maxPages Maximum pages to fetch (default {@link SEARCH_MAX_PAGES})
 * @param perPage Items per page (default 100)
 * @throws Any error from page 1, and a rate-limit or auth error from any page, unchanged
 */
export async function searchAllPages<T extends { html_url: string }>(
  fetchPage: (page: number) => Promise<{ data: SearchPage<T> }>,
  maxPages = SEARCH_MAX_PAGES,
  perPage = 100,
): Promise<SearchPagesResult<T>> {
  const seen = new Set<string>();
  const result: SearchPagesResult<T> = { items: [], totalCount: 0, pagesRead: 0, incomplete: false, truncated: false };
  let fetched = 0;
  for (let page = 1, hasMore = true; hasMore && page <= maxPages; page++) {
    const outcome = await readSearchPage(fetchPage, page);
    if ('error' in outcome) {
      result.failure = { page, error: outcome.error };
      break;
    }
    const { data } = outcome;
    result.pagesRead = page;
    result.totalCount = data.total_count;
    if (data.incomplete_results) result.incomplete = true;
    for (const item of data.items) {
      if (seen.has(item.html_url)) continue;
      seen.add(item.html_url);
      result.items.push(item);
    }
    fetched += data.items.length;
    hasMore = data.items.length >= perPage && fetched < result.totalCount;
  }
  result.truncated = result.failure !== undefined || result.incomplete || result.items.length < result.totalCount;
  return result;
}
