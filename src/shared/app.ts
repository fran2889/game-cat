import { createRequire } from "node:module";

/**
 * Application identity.
 *
 * `APP_VERSION` is read from `package.json` so the package metadata is the
 * single source of truth. Do not hardcode a version here. The product phases
 * (v1, v2, ...) are milestone names, not SemVer majors: releases follow
 * ordinary SemVer, and 1.0.0 is declared manually when the contract is stable.
 *
 * `DB_SCHEMA_VERSION` is the highest migration bundled with this build. It is
 * independent of the package version. The authoritative applied version lives
 * in `schema_migrations`; `/api/status` reports the version read from the open
 * database.
 */
const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: unknown };

if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
  throw new Error("package.json must declare a non-empty version");
}

export const APP_VERSION = packageJson.version;
export const DB_SCHEMA_VERSION = 1;
export const APP_NAME = "game-cat";

/** Minimum supported Node major, per spec §8.2. */
export const MIN_NODE_MAJOR = 24;
