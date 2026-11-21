import { METADATA_SOURCE_NAMES, type MetadataSourceName } from "./sources.ts";
import type { InternalMetadataStats, SourceCounters } from "./types.ts";

export function emptyCounters(): SourceCounters {
  return { candidates: 0, done: 0, failed: 0, skipped: 0 };
}

/** Zeroed counters for every Metadata source, derived from the canonical list. */
export function emptySourceCounters(): Record<MetadataSourceName, SourceCounters> {
  const sources = {} as Record<MetadataSourceName, SourceCounters>;
  for (const name of METADATA_SOURCE_NAMES) {
    sources[name] = emptyCounters();
  }
  return sources;
}

export function emptyInternalStats(): InternalMetadataStats {
  return {
    sources: emptySourceCounters(),
    lastProgressAt: 0,
  };
}
