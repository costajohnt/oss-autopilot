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
