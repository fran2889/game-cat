import { QueryClient } from "@tanstack/react-query";

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
