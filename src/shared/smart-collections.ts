/**
 * Wire-facing Smart Collection contracts (spec §4.2-§4.3).
 *
 * `rules` has no API ID: array position is the client-side identity, and the
 * server stores only the ordered Rule values.
 */

import type { Rule } from "./rules.ts";
import type { GameSummary, Pagination } from "./types.ts";

export const SMART_COLLECTION_SORTS = ["name", "updatedAt"] as const;
export type SmartCollectionSort = (typeof SMART_COLLECTION_SORTS)[number];

export interface SmartCollection {
  id: string;
  name: string;
  rules: Rule[];
  createdAt: string;
  updatedAt: string;
}

export interface SmartCollectionListItem {
  id: string;
  name: string;
  ruleCount: number;
  matchCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SmartCollectionsResponse {
  data: SmartCollectionListItem[];
  pagination: Pagination;
}

export interface SmartCollectionResponse {
  data: SmartCollection;
}

export interface SmartCollectionGamesResponse {
  data: GameSummary[];
  pagination: Pagination;
  meta: { dataAsOf: string | null };
}

export interface SmartCollectionCreateBody {
  name: string;
  rules?: Rule[];
}

export interface SmartCollectionPatchBody {
  name?: string;
  rules?: Rule[];
}
