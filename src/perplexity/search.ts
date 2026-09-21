import { getPerplexityClient, type Perplexity } from "./client.js";

/** Re-exported from the official SDK's generated types — not redefined here. */
export type SearchParams = Perplexity.Search.SearchCreateParams;
export type SearchResponse = Perplexity.Search.SearchCreateResponse;
export type SearchResult = SearchResponse["results"][number];

const MAX_QUERIES_PER_REQUEST = 5;

export interface SearchWebOptions
  extends Omit<SearchParams, "query"> {
  /** RequestOptions forwarded to the SDK call, e.g. { timeout, maxRetries }. */
  requestOptions?: Parameters<Perplexity["search"]["create"]>[1];
}

/**
 * Runs a Search API request (one query, or up to five independent queries in
 * one call) and returns results deduped by URL, in the order the API ranked
 * them. The API's own retry/backoff (including 429 Retry-After handling)
 * applies automatically via the SDK.
 */
export async function searchWeb(
  query: string | string[],
  options: SearchWebOptions = {},
): Promise<SearchResult[]> {
  const queries = Array.isArray(query) ? query : [query];
  if (queries.length === 0) {
    throw new Error("searchWeb requires at least one query.");
  }
  if (queries.length > MAX_QUERIES_PER_REQUEST) {
    throw new Error(
      `searchWeb accepts at most ${MAX_QUERIES_PER_REQUEST} queries per request, got ${queries.length}.`,
    );
  }

  const { requestOptions, ...searchParams } = options;
  const client = getPerplexityClient();

  const response = await client.search.create(
    {
      ...searchParams,
      query: Array.isArray(query) ? queries : queries[0]!,
    },
    requestOptions,
  );

  return dedupeByUrl(response.results);
}

/** Keeps the first (highest-ranked) occurrence of each URL. */
export function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    deduped.push(result);
  }
  return deduped;
}
