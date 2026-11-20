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

/** The part of a Search API response {@link paginateSearch} reads. */
export interface SearchPage<T> {
  total_count: number;
  incomplete_results?: boolean;
  items: T[];
}

/** Result of {@link paginateSearch}. */
export interface PaginateSearchResult<T> {
  items: T[];
  /** `total_count` from the last page read. */
  totalCount: number;
  /**
   * True when the items are not the whole result: the page cap was reached
   * with more results left, or GitHub flagged a page `incomplete_results`
   * (the search timed out server-side). Callers must surface this and must
   * not read "absent from the items" as "does not exist" (#1928).
   */
  truncated: boolean;
}

/**
 * Page cap for {@link paginateSearch}. The Search API gets unreliable at deep
 * pages and allows 30 requests a minute, so callers narrow the query rather
 * than raise this.
 */
export const SEARCH_MAX_PAGES = 3;

/**
 * Read a Search API query page by page until every result is read or the
 * page cap is reached. Errors from `fetchPage` propagate unchanged.
 *
 * @param fetchPage Function that fetches a single page given a page number
 * @param maxPages Maximum pages to fetch (default {@link SEARCH_MAX_PAGES})
 * @param perPage Items per page (default 100)
 */
export async function paginateSearch<T>(
  fetchPage: (page: number) => Promise<{ data: SearchPage<T> }>,
  maxPages = SEARCH_MAX_PAGES,
  perPage = 100,
): Promise<PaginateSearchResult<T>> {
  const items: T[] = [];
  let totalCount = 0;
  let isIncomplete = false;
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await fetchPage(page);
    items.push(...data.items);
    totalCount = data.total_count;
    if (data.incomplete_results) isIncomplete = true;
    if (data.items.length < perPage || items.length >= totalCount) break;
  }
  return { items, totalCount, truncated: isIncomplete || items.length < totalCount };
}
