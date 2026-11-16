import type BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect, type CompiledQuery } from "kysely";
import type { DatabaseSchema } from "./schema.ts";

/**
 * One Kysely instance per better-sqlite3 connection. Kysely is the typed query
 * builder; the compiled statement is executed on the existing synchronous
 * connection so the repositories keep their synchronous contract.
 */
const instances = new WeakMap<BetterSqlite3.Database, Kysely<DatabaseSchema>>();

export function queryFor(db: BetterSqlite3.Database): Kysely<DatabaseSchema> {
  let query = instances.get(db);
  if (query === undefined) {
    query = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: db }) });
    instances.set(db, query);
  }
  return query;
}

/** Run a compiled read and map every row through the query's result type. */
export function allSync<T>(db: BetterSqlite3.Database, query: CompiledQuery): T[] {
  return db.prepare(query.sql).all(...query.parameters) as T[];
}

/** Run a compiled read and take the first row, if any. */
export function firstSync<T>(db: BetterSqlite3.Database, query: CompiledQuery): T | undefined {
  return db.prepare(query.sql).get(...query.parameters) as T | undefined;
}
