/**
 * Application identity. Keep these values in sync with package.json.
 *
 * `DB_SCHEMA_VERSION` is 0 until the migration runner lands in #22. The status
 * endpoint reports it so the client can tell a fresh, unmigrated shell apart
 * from a migrated database.
 */
export const APP_VERSION = "0.1.0";
export const DB_SCHEMA_VERSION = 0;
export const APP_NAME = "game-cat";

/** Minimum supported Node major, per spec §8.2. */
export const MIN_NODE_MAJOR = 24;
