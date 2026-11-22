import { QueryClient, queryOptions, type QueryKey } from "@tanstack/react-query";

/**
 * The one query-option shape: a key and a signal-aware fetcher. TanStack's
 * `queryOptions` expects the raw `{ signal }` context; this wrapper keeps call
 * sites on `(signal) =>` and gives every view the same shape. Views add
 * per-call options such as `enabled` by spreading the result.
 */
export function defineQuery<TData, TKey extends QueryKey>(
  queryKey: TKey,
  queryFn: (signal: AbortSignal) => Promise<TData>,
) {
  return queryOptions({ queryKey, queryFn: ({ signal }) => queryFn(signal) });
}

/**
 * The client's one query cache.
 *
 * Reads never retry behind the user's back: the views keep their explicit
 * Retry buttons, so a failed request stays visible until the user asks again.
 * Focus and reconnect refetches are off for the same reason; the JSON API is
 * local and the existing views only fetched on mount or after a Refresh.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}
