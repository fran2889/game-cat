/**
 * Application identity. Keep these values in sync with package.json.
 *
 * `DB_SCHEMA_VERSION` is the highest migration bundled with this build. The
 * authoritative applied version lives in `schema_migrations`; `/api/status`
 * reports the version read from the open database.
 */
export const APP_VERSION = "1.0.0";
export const DB_SCHEMA_VERSION = 1;
export const APP_NAME = "game-cat";

/** Minimum supported Node major, per spec §8.2. */
export const MIN_NODE_MAJOR = 24;
