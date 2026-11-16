import type { InternalMetadataStats, SourceCounters } from "./types.ts";

export function emptyCounters(): SourceCounters {
  return { candidates: 0, done: 0, failed: 0, skipped: 0 };
}

export function emptyInternalStats(): InternalMetadataStats {
  return {
    sources: {
      steamspy: emptyCounters(),
      storefront: emptyCounters(),
      steam_reviews: emptyCounters(),
    },
    lastProgressAt: 0,
  };
}
