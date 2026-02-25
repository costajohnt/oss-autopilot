/** Maximum pages to fetch to prevent runaway pagination */
const MAX_PAGES = 10;

/**
 * Auto-paginate an Octokit list endpoint. Fetches additional pages when
 * the result count equals per_page (indicating more data may exist).
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
  const allItems: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await fetchPage(page);
    allItems.push(...data);
    if (data.length < perPage) break; // No more pages
  }
  return allItems;
}
