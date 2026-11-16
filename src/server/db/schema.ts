import type { GamesRow } from "../library/games.ts";

/**
 * The typed database schema Kysely builds queries against. Only the tables and
 * views read by the converted repositories are declared; later tickets extend
 * this interface as they convert more of the read and write paths.
 *
 * Column names stay snake_case because the contract is the stored schema
 * (`CODING_STANDARDS.md`: camelCase at the API, snake_case in the database).
 */
export interface TagsTable {
  id: number;
  name: string;
  name_key: string;
}

export interface GameTagsTable {
  app_id: number;
  tag_id: number;
  votes: number;
}

export interface SteamCollectionsTable {
  id: string;
  name: string;
  kind: string;
  is_dynamic: number;
  filter_spec_json: string | null;
  raw_value_json: string;
  imported_at: number;
}

export interface SteamCollectionGamesTable {
  steam_collection_id: string;
  app_id: number;
}

export interface GamesTable {
  app_id: number;
  name: string;
  name_key: string;
  ownership_status: string;
  installed: number | null;
  playtime_minutes: number;
}

export interface SteamspyAppdetailsTable {
  app_id: number;
  tags_status: string;
  tags_fetched_at: number | null;
}

export interface StorefrontAppdetailsTable {
  app_id: number;
  type: string | null;
  developers_json: string | null;
  publishers_json: string | null;
  genres_json: string | null;
  categories_json: string | null;
  platforms_json: string | null;
  release_date_raw: string | null;
  release_year: number | null;
  metacritic_score: number | null;
  store_status: string;
  store_fetched_at: number | null;
}

export interface SteamReviewSummariesTable {
  app_id: number;
  review_status: string;
  review_fetched_at: number | null;
  review_positive: number | null;
  review_negative: number | null;
  review_total: number | null;
  review_tier: string | null;
}

export interface SourceStateTable {
  name: string;
  status: string;
  last_success_at: number | null;
  last_attempt_at: number | null;
  retry_after_at: number | null;
  last_error: string | null;
}

export interface SmartCollectionsTable {
  id: string;
  name: string;
  name_key: string;
  created_at: number;
  updated_at: number;
}

export interface RulesTable {
  smart_collection_id: string;
  position: number;
  prefix: string;
  field: string;
  operator: string;
  value_json: string;
}

export interface DatabaseSchema {
  games: GamesTable;
  steamspy_appdetails: SteamspyAppdetailsTable;
  storefront_appdetails: StorefrontAppdetailsTable;
  steam_review_summaries: SteamReviewSummariesTable;
  source_state: SourceStateTable;
  smart_collections: SmartCollectionsTable;
  rules: RulesTable;
  v_games: GamesRow;
  tags: TagsTable;
  game_tags: GameTagsTable;
  steam_collections: SteamCollectionsTable;
  steam_collection_games: SteamCollectionGamesTable;
}
