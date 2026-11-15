import type BetterSqlite3 from "better-sqlite3";
import { WORKED_LIBRARY, WORKED_STEAM_COLLECTIONS } from "./rule-fixture.ts";

const FETCHED_AT = 1_700_000_000;

/** Seed the §5.8 Library into a real SQLite database for endpoint tests. */
export function seedWorkedLibrary(db: BetterSqlite3.Database): void {
  db.transaction(() => {
    for (const game of WORKED_LIBRARY) {
      db.prepare(
        `INSERT INTO games (
           app_id, name, name_key, name_source, ownership_status, installed,
           playtime_minutes, manifest_last_played_at, source_mask,
           first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, 'storefront', ?, ?, ?, ?, 1, 1, 1)`,
      ).run(
        game.appId,
        game.name,
        game.name.toLowerCase(),
        game.ownershipStatus,
        game.installed === null ? null : game.installed ? 1 : 0,
        game.playtimeMinutes,
        game.lastPlayedAt,
      );

      if (game.storefrontType !== null) {
        db.prepare(
          `INSERT INTO storefront_appdetails (
             app_id, type, developers_json, publishers_json, genres_json, categories_json,
             platforms_json, release_date_raw, release_year, metacritic_score,
             store_status, store_fetched_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'ok', ?, ?)`,
        ).run(
          game.appId,
          game.storefrontType,
          JSON.stringify(game.developers),
          JSON.stringify(game.publishers),
          JSON.stringify(game.genres),
          JSON.stringify(game.categories),
          JSON.stringify(
            Object.fromEntries(
              ["windows", "mac", "linux"].map((name) => [name, game.platforms.includes(name)]),
            ),
          ),
          game.releaseYear,
          game.metacriticScore,
          FETCHED_AT,
          FETCHED_AT,
        );
      }

      db.prepare(
        `INSERT INTO steamspy_appdetails (app_id, tags_status, tags_fetched_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run(game.appId, game.tags.length > 0 ? "ok" : "missing", FETCHED_AT, FETCHED_AT);

      for (const tag of game.tags) {
        db.prepare("INSERT OR IGNORE INTO tags (name, name_key) VALUES (?, ?)").run(
          tag,
          tag.toLowerCase(),
        );
        const row = db.prepare("SELECT id FROM tags WHERE name_key = ?").get(tag.toLowerCase()) as {
          id: number;
        };
        db.prepare("INSERT INTO game_tags (app_id, tag_id, votes) VALUES (?, ?, ?)").run(
          game.appId,
          row.id,
          game.appId * 10,
        );
      }

      const reviewPositive =
        game.reviewCount === null
          ? null
          : game.reviewScore === null
            ? 0
            : Math.round((game.reviewScore * game.reviewCount) / 100);
      db.prepare(
        `INSERT INTO steam_review_summaries (
           app_id, review_positive, review_negative, review_total, review_tier,
           review_status, review_fetched_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        game.appId,
        reviewPositive,
        reviewPositive === null || game.reviewCount === null
          ? null
          : game.reviewCount - reviewPositive,
        game.reviewCount,
        game.reviewTier,
        game.reviewCount === null ? "missing" : "ok",
        FETCHED_AT,
        FETCHED_AT,
      );
    }

    for (const collection of WORKED_STEAM_COLLECTIONS) {
      db.prepare(
        `INSERT INTO steam_collections (
           id, name, kind, is_dynamic, filter_spec_json, raw_value_json, imported_at
         ) VALUES (?, ?, ?, ?, ?, '{}', 1)`,
      ).run(
        collection.id,
        collection.name,
        collection.kind,
        collection.isDynamic ? 1 : 0,
        collection.isDynamic ? '{"filter":true}' : null,
      );
      if (!collection.isDynamic) {
        const members = WORKED_LIBRARY.filter((game) =>
          game.steamCollections.includes(collection.id),
        );
        for (const game of members) {
          db.prepare(
            "INSERT INTO steam_collection_games (steam_collection_id, app_id) VALUES (?, ?)",
          ).run(collection.id, game.appId);
        }
      }
    }
  })();
}
