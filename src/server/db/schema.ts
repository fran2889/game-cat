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

export interface DatabaseSchema {
  v_games: GamesRow;
  tags: TagsTable;
  game_tags: GameTagsTable;
  steam_collections: SteamCollectionsTable;
  steam_collection_games: SteamCollectionGamesTable;
}
