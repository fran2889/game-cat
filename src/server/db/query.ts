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

/** Run a compiled read and cast every row to T; the caller asserts the row shape. */
export function allSync<T>(db: BetterSqlite3.Database, query: CompiledQuery): T[] {
  return db.prepare(query.sql).all(...query.parameters) as T[];
}

/** Run a compiled write and return the driver's change metadata. */
export function runSync(
  db: BetterSqlite3.Database,
  query: CompiledQuery,
): { changes: number; lastInsertRowid: number | bigint } {
  return statementFor(db, query.sql).run(...query.parameters);
}

/**
 * Reuse one prepared statement per write shape. Repositories replay the same
 * statement once per row (a 20,000-Game scan, an ownership roster, a Tag set),
 * and better-sqlite3 statements are immutable and safe to replay. Reads stay
 * uncached because they are issued once per request, not once per row.
 */
const writeStatements = new WeakMap<BetterSqlite3.Database, Map<string, BetterSqlite3.Statement>>();

function statementFor(db: BetterSqlite3.Database, sql: string): BetterSqlite3.Statement {
  let statements = writeStatements.get(db);
  if (statements === undefined) {
    statements = new Map();
    writeStatements.set(db, statements);
  }
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

/** Run a compiled read and take the first row, if any. */
export function firstSync<T>(db: BetterSqlite3.Database, query: CompiledQuery): T | undefined {
  return db.prepare(query.sql).get(...query.parameters) as T | undefined;
}
