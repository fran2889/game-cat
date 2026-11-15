import type BetterSqlite3 from "better-sqlite3";
import type { RulesPreviewRequest } from "../../shared/rules.ts";
import { readDataAsOf, type GameListResult } from "./games.ts";
import { evaluateLibrary, pageMatches, readLibrary } from "./rule-library.ts";

/**
 * Evaluates an unsaved Rules array over the current Library (spec §5.5.2).
 *
 * The Library is read once through `v_games` plus Tags and static Steam
 * Collection membership, matched in memory, then sorted and paged. Reads only:
 * the endpoint never persists Rules and never writes a row.
 */
export class RulePreviewRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  preview(request: RulesPreviewRequest): GameListResult {
    const library = readLibrary(this.db);
    const matched = evaluateLibrary(library, request.rules);
    const page = pageMatches(this.db, matched, request);
    return {
      ...page,
      meta: { dataAsOf: readDataAsOf(this.db) },
    };
  }
}
