import type { Generated } from "kysely";
import type { GamesRow } from "../library/games.ts";

/**
 * The typed database schema Kysely builds queries against. It models every
 * table, view, and column the repositories read or write; migrations stay
 * hand-written (§1.5, ADR 0004).
 *
 * Column names stay snake_case because the contract is the stored schema
 * (`CODING_STANDARDS.md`: camelCase at the API, snake_case in the database).
 * Columns with a database default are `Generated` so an insert may omit them.
 */
export interface AccountStateTable {
  singleton: number;
  steam_id64: string;
  bound_at: number;
}

export interface TagsTable {
  id: Generated<number>;
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
  is_dynamic: Generated<number>;
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
  name_source: Generated<string>;
  ownership_status: Generated<string>;
  installed: number | null;
  library_path: string | null;
  install_dir: string | null;
  size_on_disk_bytes: number | null;
  state_flags: number | null;
  local_playtime_minutes: number | null;
  api_playtime_minutes: number | null;
  playtime_minutes: Generated<number>;
  local_playtime_2weeks_minutes: number | null;
  api_playtime_2weeks_minutes: number | null;
  playtime_2weeks_minutes: number | null;
  manifest_last_played_at: number | null;
  localconfig_last_played_at: number | null;
  last_updated_at: number | null;
  source_mask: Generated<number>;
  first_seen_at: number;
  last_seen_at: number;
}

export interface SteamspyAppdetailsTable {
  app_id: number;
  steamspy_name: string | null;
  tags_status: Generated<string>;
  tags_fetched_at: number | null;
  tags_error: string | null;
  raw_steamspy_json: string | null;
  updated_at: number;
}

export interface StorefrontAppdetailsTable {
  app_id: number;
  type: string | null;
  developers_json: Generated<string>;
  publishers_json: Generated<string>;
  genres_json: Generated<string>;
  categories_json: Generated<string>;
  platforms_json: Generated<string>;
  release_date_raw: string | null;
  release_year: number | null;
  metacritic_score: number | null;
  store_status: Generated<string>;
  store_fetched_at: number | null;
  store_error: string | null;
  raw_store_json: string | null;
  updated_at: number;
}

export interface SteamReviewSummariesTable {
  app_id: number;
  review_positive: number | null;
  review_negative: number | null;
  review_total: number | null;
  review_tier: string | null;
  review_status: Generated<string>;
  review_fetched_at: number | null;
  review_error: string | null;
  raw_reviews_json: string | null;
  updated_at: number;
}

export interface SourceStateTable {
  name: string;
  status: string;
  last_success_at: number | null;
  last_attempt_at: number | null;
  retry_after_at: number | null;
  last_error: string | null;
}

export interface RefreshRunsTable {
  id: Generated<number>;
  scope: string;
  mode: string | null;
  status: string;
  steam_id64: string | null;
  started_at: number;
  finished_at?: number | null;
  total?: number | null;
  done: Generated<number>;
  stats_json?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  app_ids_json?: string | null;
}

export interface SmartCollectionsTable {
  id: string;
  name: string;
  name_key: string;
  created_at: number;
  updated_at: number;
}

export interface RulesTable {
  id: Generated<number>;
  smart_collection_id: string;
  position: number;
  prefix: string;
  field: string;
  operator: string;
  value_json: string;
}

export interface DatabaseSchema {
  account_state: AccountStateTable;
  games: GamesTable;
  steamspy_appdetails: SteamspyAppdetailsTable;
  storefront_appdetails: StorefrontAppdetailsTable;
  steam_review_summaries: SteamReviewSummariesTable;
  source_state: SourceStateTable;
  refresh_runs: RefreshRunsTable;
  smart_collections: SmartCollectionsTable;
  rules: RulesTable;
  v_games: GamesRow;
  tags: TagsTable;
  game_tags: GameTagsTable;
  steam_collections: SteamCollectionsTable;
  steam_collection_games: SteamCollectionGamesTable;
}
