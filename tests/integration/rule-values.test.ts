import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../../src/server/db/database.ts";
import { createHttpApp } from "../../src/server/http/app.ts";
import { SteamCollectionsRepository } from "../../src/server/library/collections.ts";
import { GamesRepository } from "../../src/server/library/games.ts";
import { RulePreviewRepository } from "../../src/server/library/rule-preview.ts";
import { RuleValuesRepository } from "../../src/server/library/rule-values.ts";
import { TagsRepository } from "../../src/server/library/tags.ts";
import { RefreshService } from "../../src/server/refresh/service.ts";
import type { RuleValuesResponse, Status } from "../../src/shared/types.ts";

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;

const dataDirs: string[] = [];
const databases: AppDatabase[] = [];
const apps: Array<ReturnType<typeof createHttpApp>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (dataDirs.length > 0) {
    rmSync(dataDirs.pop()!, { recursive: true, force: true });
  }
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-rule-values-"));
  dataDirs.push(dir);
  const db = openAppDatabase({ dataDir: dir, steamWebApiConfigured: false });
  databases.push(db);
  const refresh = new RefreshService({
    db: db.raw,
    steamRoot: null,
    steamId64: null,
    now: () => 1_700_000_000,
  });
  const app = createHttpApp({
    port: PORT,
    clientDir: null,
    logger: pino({ level: "silent" }),
    status: () => ({}) as Status,
    library: {
      games: new GamesRepository(db.raw),
      collections: new SteamCollectionsRepository(db.raw),
      ruleValues: new RuleValuesRepository(db.raw),
      rulePreview: new RulePreviewRepository(db.raw),
      tags: new TagsRepository(db.raw),
      refresh,
    },
  });
  apps.push(app);
  return { db, app };
}

function seed(
  db: AppDatabase,
  appId: number,
  values: {
    genres?: string[];
    categories?: string[];
    developers?: string[];
    publishers?: string[];
  } = {},
): void {
  db.raw
    .prepare(
      `INSERT INTO games (
         app_id, name, name_key, name_source, ownership_status,
         playtime_minutes, source_mask, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, 'local', 'owned', 0, 1, 1, 1)`,
    )
    .run(appId, `Game ${appId}`, `game ${appId}`);
  db.raw
    .prepare(
      `INSERT INTO storefront_appdetails (
         app_id, genres_json, categories_json, developers_json, publishers_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .run(
      appId,
      JSON.stringify(values.genres ?? []),
      JSON.stringify(values.categories ?? []),
      JSON.stringify(values.developers ?? []),
      JSON.stringify(values.publishers ?? []),
    );
}

async function get(app: ReturnType<typeof createHttpApp>, url: string) {
  return app.inject({ method: "GET", url, headers: { host: HOST } });
}

async function ruleValues(
  app: ReturnType<typeof createHttpApp>,
  query: string,
): Promise<RuleValuesResponse> {
  const response = await get(app, `/api/rule-values?${query}`);
  expect(response.statusCode).toBe(200);
  return response.json() as RuleValuesResponse;
}

describe("GET /api/rule-values", () => {
  it("returns distinct values and distinct-Game counts for all four fields", async () => {
    const { db, app } = harness();
    seed(db, 1, {
      genres: ["Action", "Adventure", "action"],
      categories: ["Single-player", "Co-op"],
      developers: ["Valve"],
      publishers: ["Valve"],
    });
    seed(db, 2, {
      genres: ["Action", "Indie"],
      categories: ["single-player"],
      developers: ["valve", "Other"],
      publishers: ["Valve Publishing"],
    });
    seed(db, 3, {
      genres: ["action", "Strategy"],
      categories: ["Co-op", "Steam Workshop", "Steam Workshop"],
      developers: ["Other"],
      publishers: ["Other"],
    });
    seed(db, 4);

    const genres = await ruleValues(app, "field=genre");
    expect(genres.data).toEqual([
      { value: "Action", gameCount: 3 },
      { value: "Adventure", gameCount: 1 },
      { value: "Indie", gameCount: 1 },
      { value: "Strategy", gameCount: 1 },
    ]);
    expect(genres.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 4,
      totalPages: 1,
    });

    const categories = await ruleValues(app, "field=category");
    expect(categories.data).toEqual([
      { value: "Co-op", gameCount: 2 },
      { value: "Single-player", gameCount: 2 },
      { value: "Steam Workshop", gameCount: 1 },
    ]);

    const developers = await ruleValues(app, "field=developer");
    expect(developers.data).toEqual([
      { value: "Other", gameCount: 2 },
      { value: "Valve", gameCount: 2 },
    ]);

    const publishers = await ruleValues(app, "field=publisher");
    expect(publishers.data).toEqual([
      { value: "Other", gameCount: 1 },
      { value: "Valve", gameCount: 1 },
      { value: "Valve Publishing", gameCount: 1 },
    ]);
  });

  it("matches the normalized query case-insensitively and trims it", async () => {
    const { db, app } = harness();
    seed(db, 1, { genres: ["Action", "Adventure"] });
    seed(db, 2, { genres: ["Strategy"] });

    expect((await ruleValues(app, "field=genre&query=%20ACT%20")).data).toEqual([
      { value: "Action", gameCount: 1 },
    ]);
    expect((await ruleValues(app, "field=genre&query=vent")).data).toEqual([
      { value: "Adventure", gameCount: 1 },
    ]);
    expect((await ruleValues(app, "field=genre&query=nomatch")).data).toEqual([]);

    const empty = await ruleValues(app, "field=genre&query=nomatch");
    expect(empty.pagination).toEqual({ page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
  });

  it("paginates in count-then-normalized-value order", async () => {
    const { db, app } = harness();
    seed(db, 1, { genres: ["Zeta", "alpha"] });
    seed(db, 2, { genres: ["Zeta", "Beta"] });
    seed(db, 3, { genres: ["Zeta", "Gamma"] });

    const first = await ruleValues(app, "field=genre&pageSize=2");
    expect(first.data).toEqual([
      { value: "Zeta", gameCount: 3 },
      { value: "alpha", gameCount: 1 },
    ]);
    expect(first.pagination).toEqual({ page: 1, pageSize: 2, totalItems: 4, totalPages: 2 });

    const second = await ruleValues(app, "field=genre&pageSize=2&page=2");
    expect(second.data).toEqual([
      { value: "Beta", gameCount: 1 },
      { value: "Gamma", gameCount: 1 },
    ]);

    const outOfRange = await ruleValues(app, "field=genre&pageSize=2&page=3");
    expect(outOfRange.data).toEqual([]);
    expect(outOfRange.pagination).toEqual({
      page: 3,
      pageSize: 2,
      totalItems: 4,
      totalPages: 2,
    });
  });

  it("excludes values with no Games", async () => {
    const { db, app } = harness();
    seed(db, 1, { genres: ["Only"] });
    db.raw.prepare("DELETE FROM games WHERE app_id = 1").run();

    const result = await ruleValues(app, "field=genre");
    expect(result.data).toEqual([]);
    expect(result.pagination.totalItems).toBe(0);
  });

  const invalid: Array<{ query: string; field: string }> = [
    { query: "", field: "field" },
    { query: "field=tag", field: "field" },
    { query: "field=TAG", field: "field" },
    { query: `field=genre&query=${"x".repeat(81)}`, field: "query" },
    { query: "field=genre&page=0", field: "page" },
    { query: "field=genre&page=nope", field: "page" },
    { query: "field=genre&pageSize=101", field: "pageSize" },
    { query: "field=genre&pageSize=0", field: "pageSize" },
  ];

  for (const entry of invalid) {
    it(`rejects /api/rule-values?${entry.query} at ${entry.field}`, async () => {
      const { app } = harness();
      const response = await get(app, `/api/rule-values?${entry.query}`);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          details: { fieldErrors: { [entry.field]: expect.any(String) } },
        },
      });
    });
  }
});
