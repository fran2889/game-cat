import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** One bundled, forward-only migration. */
export interface Migration {
  /** Monotonically increasing number from the file name, starting at 1. */
  version: number;
  /** The file's slug, for example `initial` from `0001_initial.sql`. */
  name: string;
  sql: string;
}

const FILE_PATTERN = /^(\d{4})_(.+)\.sql$/;
const SOURCE_DIR = resolve(import.meta.dirname, "../../../migrations");
const BUILD_DIR = resolve(import.meta.dirname, "../../migrations");

/**
 * The migrations bundled with the app. Source runs (tsx, Vitest) read the
 * repository `migrations/` directory; a build reads `dist/migrations`, which
 * `npm run build` copies.
 */
export function defaultMigrationsDir(): string {
  if (import.meta.filename.endsWith(".ts")) {
    return SOURCE_DIR;
  }
  return existsSync(BUILD_DIR) ? BUILD_DIR : SOURCE_DIR;
}

/**
 * Read and validate `NNNN_slug.sql` files. Files are immutable once released,
 * so a duplicate or malformed version is a programming error, not a startup
 * condition the user can fix.
 */
export function loadMigrations(dir: string = defaultMigrationsDir()): Migration[] {
  const files = readdirSync(dir)
    .filter((name) => FILE_PATTERN.test(name))
    .sort();

  const migrations: Migration[] = [];
  const seen = new Set<number>();
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (match === null) {
      continue;
    }
    const version = Number.parseInt(match[1]!, 10);
    if (version < 1 || seen.has(version)) {
      throw new Error(`migrations: invalid or duplicate version in ${join(dir, file)}`);
    }
    seen.add(version);
    migrations.push({
      version,
      name: match[2]!,
      sql: readFileSync(join(dir, file), "utf8"),
    });
  }

  migrations.sort((left, right) => left.version - right.version);
  return migrations;
}

/** The highest bundled migration version, or 0 when the bundle is empty. */
export function highestBundledVersion(migrations: readonly Migration[]): number {
  return migrations.at(-1)?.version ?? 0;
}
