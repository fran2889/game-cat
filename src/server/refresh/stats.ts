import { METADATA_SOURCE_NAMES, type MetadataSourceName } from "../../shared/types.ts";
import type { InternalMetadataStats, SourceCounters } from "./types.ts";

function emptySourceCounter(): SourceCounters {
  return { candidates: 0, done: 0, failed: 0, skipped: 0 };
}

/** Zeroed counters for every Metadata source, derived from the canonical list. */
export function emptySourceCounters(): Record<MetadataSourceName, SourceCounters> {
  return Object.fromEntries(
    METADATA_SOURCE_NAMES.map((name) => [name, emptySourceCounter()] as const),
  ) as Record<MetadataSourceName, SourceCounters>;
}

export function emptyInternalStats(): InternalMetadataStats {
  return {
    sources: emptySourceCounters(),
    lastProgressAt: 0,
  };
}
