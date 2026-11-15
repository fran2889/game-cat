-- One Steam Account per data directory.
CREATE TABLE account_state (
    singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
    steam_id64 TEXT    NOT NULL CHECK (length(steam_id64) > 0),
    bound_at   INTEGER NOT NULL
);

-- Games: identity, Ownership, and local Steam state.
CREATE TABLE games (
    app_id                        INTEGER PRIMARY KEY,
    name                          TEXT    NOT NULL,
    name_key                      TEXT    NOT NULL,
    name_source                   TEXT    NOT NULL DEFAULT 'placeholder'
                                          CHECK (name_source IN ('placeholder', 'local', 'steam_web_api', 'steamspy', 'storefront')),
    ownership_status              TEXT    NOT NULL DEFAULT 'unknown'
                                          CHECK (ownership_status IN ('owned', 'local_only', 'unknown')),
    installed                     INTEGER          CHECK (installed IN (0, 1) OR installed IS NULL),
    library_path                  TEXT,
    install_dir                   TEXT,
    size_on_disk_bytes            INTEGER          CHECK (size_on_disk_bytes IS NULL OR size_on_disk_bytes >= 0),
    state_flags                   INTEGER,
    local_playtime_minutes        INTEGER          CHECK (local_playtime_minutes IS NULL OR local_playtime_minutes >= 0),
    api_playtime_minutes          INTEGER          CHECK (api_playtime_minutes IS NULL OR api_playtime_minutes >= 0),
    playtime_minutes              INTEGER NOT NULL DEFAULT 0
                                          CHECK (playtime_minutes >= 0),
    local_playtime_2weeks_minutes INTEGER          CHECK (local_playtime_2weeks_minutes IS NULL OR local_playtime_2weeks_minutes >= 0),
    api_playtime_2weeks_minutes   INTEGER          CHECK (api_playtime_2weeks_minutes IS NULL OR api_playtime_2weeks_minutes >= 0),
    playtime_2weeks_minutes       INTEGER          CHECK (playtime_2weeks_minutes IS NULL OR playtime_2weeks_minutes >= 0),
    manifest_last_played_at       INTEGER          CHECK (manifest_last_played_at IS NULL OR manifest_last_played_at >= 0),
    localconfig_last_played_at    INTEGER          CHECK (localconfig_last_played_at IS NULL OR localconfig_last_played_at >= 0),
    last_updated_at               INTEGER          CHECK (last_updated_at IS NULL OR last_updated_at >= 0),
    source_mask                   INTEGER NOT NULL DEFAULT 0 CHECK (source_mask >= 0),
    first_seen_at                 INTEGER NOT NULL,
    last_seen_at                  INTEGER NOT NULL
);

-- SteamSpy data, one row per fetched Game.
CREATE TABLE steamspy_appdetails (
    app_id            INTEGER PRIMARY KEY REFERENCES games(app_id) ON DELETE CASCADE,
    steamspy_name     TEXT,
    tags_status       TEXT NOT NULL DEFAULT 'missing'
                      CHECK (tags_status IN ('ok', 'missing', 'stale', 'error')),
    tags_fetched_at   INTEGER,
    tags_error        TEXT,
    raw_steamspy_json TEXT,
    updated_at        INTEGER NOT NULL
);

-- Storefront data, one row per fetched Game.
CREATE TABLE storefront_appdetails (
    app_id           INTEGER PRIMARY KEY REFERENCES games(app_id) ON DELETE CASCADE,
    type             TEXT,
    developers_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(developers_json)),
    publishers_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(publishers_json)),
    genres_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(genres_json)),
    categories_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(categories_json)),
    platforms_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(platforms_json)),
    release_date_raw TEXT,
    release_year     INTEGER,
    metacritic_score INTEGER,
    store_status     TEXT NOT NULL DEFAULT 'missing'
                     CHECK (store_status IN ('ok', 'unavailable', 'missing', 'stale', 'error')),
    store_fetched_at INTEGER,
    store_error      TEXT,
    raw_store_json   TEXT,
    updated_at       INTEGER NOT NULL
);

-- Steam review summary, one row per fetched Game.
CREATE TABLE steam_review_summaries (
    app_id            INTEGER PRIMARY KEY REFERENCES games(app_id) ON DELETE CASCADE,
    review_positive   INTEGER CHECK (review_positive IS NULL OR review_positive >= 0),
    review_negative   INTEGER CHECK (review_negative IS NULL OR review_negative >= 0),
    review_total      INTEGER CHECK (review_total IS NULL OR review_total >= 0),
    review_tier       TEXT,
    review_status     TEXT NOT NULL DEFAULT 'missing'
                      CHECK (review_status IN ('ok', 'unavailable', 'missing', 'stale', 'error')),
    review_fetched_at INTEGER CHECK (review_fetched_at IS NULL OR review_fetched_at >= 0),
    review_error      TEXT,
    raw_reviews_json  TEXT CHECK (raw_reviews_json IS NULL OR json_valid(raw_reviews_json)),
    updated_at        INTEGER NOT NULL,
    CHECK (
        (review_positive IS NULL AND review_negative IS NULL AND review_total IS NULL)
        OR (
            review_positive IS NOT NULL
            AND review_negative IS NOT NULL
            AND review_total IS NOT NULL
            AND review_positive + review_negative = review_total
        )
    )
);

-- Tag vocabulary and per-Game vote counts.
CREATE TABLE tags (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE
);

CREATE TABLE game_tags (
    app_id INTEGER NOT NULL REFERENCES games(app_id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    votes  INTEGER NOT NULL CHECK (votes >= 0),
    PRIMARY KEY (app_id, tag_id)
);

-- Read-only mirror of Steam Collections.
CREATE TABLE steam_collections (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('favorite', 'hidden', 'user', 'tag', 'system', 'other')),
    is_dynamic       INTEGER NOT NULL DEFAULT 0 CHECK (is_dynamic IN (0, 1)),
    filter_spec_json TEXT CHECK (filter_spec_json IS NULL OR json_valid(filter_spec_json)),
    raw_value_json   TEXT NOT NULL CHECK (json_valid(raw_value_json)),
    imported_at      INTEGER NOT NULL
);

CREATE TABLE steam_collection_games (
    steam_collection_id TEXT NOT NULL REFERENCES steam_collections(id) ON DELETE CASCADE,
    app_id              INTEGER NOT NULL REFERENCES games(app_id) ON DELETE CASCADE,
    PRIMARY KEY (steam_collection_id, app_id)
);

-- game-cat-owned Smart Collections.
CREATE TABLE smart_collections (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE rules (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    smart_collection_id TEXT NOT NULL REFERENCES smart_collections(id) ON DELETE CASCADE,
    position            INTEGER NOT NULL CHECK (position >= 0),
    prefix              TEXT NOT NULL CHECK (prefix IN ('AND', 'OR', 'NOT')),
    field               TEXT NOT NULL CHECK (length(trim(field)) > 0),
    operator            TEXT NOT NULL CHECK (length(trim(operator)) > 0),
    value_json          TEXT NOT NULL CHECK (json_valid(value_json)),
    UNIQUE (smart_collection_id, position)
);

-- Refresh history and source health.
CREATE TABLE refresh_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    scope         TEXT NOT NULL CHECK (scope IN ('library', 'ownership', 'metadata', 'all')),
    mode          TEXT CHECK (mode IN ('fetch', 'full') OR mode IS NULL),
    status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
    steam_id64    TEXT,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    total         INTEGER CHECK (total IS NULL OR total >= 0),
    done          INTEGER NOT NULL DEFAULT 0 CHECK (done >= 0),
    app_ids_json  TEXT CHECK (app_ids_json IS NULL OR json_valid(app_ids_json)),
    error_code    TEXT,
    error_message TEXT,
    stats_json    TEXT CHECK (stats_json IS NULL OR json_valid(stats_json)),
    CHECK (
        (scope IN ('library', 'ownership') AND mode IS NULL AND app_ids_json IS NULL)
        OR (scope = 'all' AND mode = 'fetch' AND app_ids_json IS NULL)
        OR (scope = 'metadata' AND mode = 'fetch' AND app_ids_json IS NULL)
        OR (scope = 'metadata' AND mode = 'full' AND app_ids_json IS NOT NULL)
    )
);

CREATE TABLE source_state (
    name            TEXT PRIMARY KEY
                    CHECK (name IN ('steam_local', 'steam_web_api', 'steamspy', 'storefront', 'steam_reviews')),
    status          TEXT NOT NULL
                    CHECK (status IN ('unknown', 'ok', 'partial', 'empty', 'stale',
                                      'not_configured', 'invalid_key', 'rate_limited',
                                      'blocked', 'offline', 'error')),
    last_success_at INTEGER,
    last_attempt_at INTEGER,
    retry_after_at  INTEGER,
    last_error      TEXT
);

-- Query surface used by the list and detail endpoints. It also exposes raw local fields for
-- diagnostics and future Fields.
CREATE VIEW v_games AS
SELECT
    g.app_id,
    g.name,
    g.name_key,
    g.name_source,
    g.ownership_status,
    g.installed,
    g.library_path,
    g.install_dir,
    g.size_on_disk_bytes,
    g.state_flags,
    g.local_playtime_minutes,
    g.api_playtime_minutes,
    g.playtime_minutes,
    g.local_playtime_2weeks_minutes,
    g.api_playtime_2weeks_minutes,
    g.playtime_2weeks_minutes,
    g.last_updated_at,
    g.source_mask,
    g.first_seen_at,
    g.last_seen_at,
    CASE
        WHEN COALESCE(g.manifest_last_played_at, 0) = 0
         AND COALESCE(g.localconfig_last_played_at, 0) = 0 THEN NULL
        ELSE MAX(COALESCE(g.manifest_last_played_at, 0),
                 COALESCE(g.localconfig_last_played_at, 0))
    END AS last_played_at,
    sf.type,
    COALESCE(sf.developers_json, '[]') AS developers_json,
    COALESCE(sf.publishers_json, '[]') AS publishers_json,
    COALESCE(sf.genres_json, '[]')     AS genres_json,
    COALESCE(sf.categories_json, '[]') AS categories_json,
    sf.platforms_json                  AS platforms_json,
    sf.release_date_raw,
    sf.release_year,
    sf.metacritic_score,
    COALESCE(sp.tags_status, 'missing')    AS tags_status,
    sp.tags_fetched_at,
    COALESCE(sf.store_status, 'missing')   AS store_status,
    sf.store_fetched_at,
    COALESCE(sr.review_status, 'missing')  AS review_status,
    sr.review_fetched_at,
    sr.review_positive,
    sr.review_negative,
    sr.review_total,
    sr.review_tier,
    CASE
        WHEN sr.review_total > 0
        THEN MIN(100, CAST(ROUND(100.0 * sr.review_positive / sr.review_total) AS INTEGER))
        ELSE NULL
    END AS review_score
FROM games g
LEFT JOIN steamspy_appdetails sp ON sp.app_id = g.app_id
LEFT JOIN storefront_appdetails sf ON sf.app_id = g.app_id
LEFT JOIN steam_review_summaries sr ON sr.app_id = g.app_id;

CREATE INDEX idx_games_name              ON games(name_key);
CREATE INDEX idx_games_ownership         ON games(ownership_status);
CREATE INDEX idx_games_installed         ON games(installed);
CREATE INDEX idx_games_playtime          ON games(playtime_minutes DESC);
CREATE INDEX idx_game_tags_tag           ON game_tags(tag_id, votes DESC);
CREATE INDEX idx_steam_collection_games  ON steam_collection_games(app_id);
CREATE INDEX idx_steam_collections_name  ON steam_collections(name, id);
CREATE INDEX idx_refresh_runs_started    ON refresh_runs(started_at DESC);
CREATE INDEX idx_refresh_runs_running    ON refresh_runs(scope, status)
                                         WHERE status IN ('queued', 'running');
CREATE INDEX idx_steamspy_tags_status    ON steamspy_appdetails(tags_status);
CREATE INDEX idx_storefront_release      ON storefront_appdetails(release_year);
CREATE INDEX idx_storefront_metacritic   ON storefront_appdetails(metacritic_score);
CREATE INDEX idx_storefront_status       ON storefront_appdetails(store_status);
CREATE INDEX idx_steam_reviews_status    ON steam_review_summaries(review_status);
CREATE INDEX idx_steam_reviews_total     ON steam_review_summaries(review_total);
