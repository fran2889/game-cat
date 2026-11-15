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
import { SmartCollectionsRepository } from "../../src/server/library/smart-collections.ts";
import { evaluateRuleIds } from "../../src/server/library/rule-evaluator.ts";
import { RuleValuesRepository } from "../../src/server/library/rule-values.ts";
import { TagsRepository } from "../../src/server/library/tags.ts";
import { RefreshService } from "../../src/server/refresh/service.ts";
import type { GamesResponse, Status } from "../../src/shared/types.ts";
import { WORKED_CASES, WORKED_LIBRARY } from "../helpers/rule-fixture.ts";
import { seedWorkedLibrary } from "../helpers/rule-db.ts";

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;
const PREVIEW = "/api/rules/preview";

const dataDirs: string[] = [];
const databases: AppDatabase[] = [];
const apps: Array<ReturnType<typeof createHttpApp>> = [];

interface Harness {
  db: AppDatabase;
  app: ReturnType<typeof createHttpApp>;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-rules-preview-"));
  dataDirs.push(dir);
  const db = openAppDatabase({ dataDir: dir, steamWebApiConfigured: false });
  databases.push(db);
  seedWorkedLibrary(db.raw);
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
      tags: new TagsRepository(db.raw),
      rulePreview: new RulePreviewRepository(db.raw),
      smartCollections: new SmartCollectionsRepository(db.raw),
      refresh,
    },
  });
  apps.push(app);
  return { db, app };
}

async function preview(app: ReturnType<typeof createHttpApp>, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: PREVIEW,
    headers: { host: HOST, "content-type": "application/json" },
    payload: body,
  });
}

async function previewIds(
  app: ReturnType<typeof createHttpApp>,
  rules: unknown[],
): Promise<number[]> {
  const response = await preview(app, { rules, pageSize: 200, sort: "appId", order: "asc" });
  expect(response.statusCode).toBe(200);
  const body = response.json() as GamesResponse;
  return body.data.map((game) => game.appId);
}

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

describe("POST /api/rules/preview worked cases", () => {
  for (const worked of WORKED_CASES) {
    it(`case ${worked.number}: ${worked.proves}`, async () => {
      const { app } = harness();
      expect(await previewIds(app, worked.rules)).toEqual(worked.matches);
    });
  }

  it("returns the same membership as the pure evaluator for every worked case", async () => {
    const { app } = harness();
    for (const worked of WORKED_CASES) {
      expect(await previewIds(app, worked.rules)).toEqual(
        evaluateRuleIds(worked.rules, WORKED_LIBRARY),
      );
    }
  });

  it("matches every Game for an empty Rules array", async () => {
    const { app } = harness();
    const response = await preview(app, { rules: [] });
    expect(response.statusCode).toBe(200);
    const body = response.json() as GamesResponse;
    expect(body.pagination).toEqual({ page: 1, pageSize: 60, totalItems: 7, totalPages: 1 });
    expect(body.data.map((game) => game.appId)).toEqual([10, 4000, 999, 570, 620, 800, 700]);
  });

  it("defaults to name ascending and follows the documented nulls-last order", async () => {
    const { app } = harness();
    const byName = await preview(app, { rules: [] });
    expect((byName.json() as GamesResponse).data.map((game) => game.name)).toEqual([
      "Alpha",
      "Delta",
      "Epsilon",
      "Gamma",
      "Portal 2",
      "Theta",
      "Zeta",
    ]);

    const ascending = await preview(app, { rules: [], sort: "releaseYear", order: "asc" });
    expect((ascending.json() as GamesResponse).data.map((game) => game.appId)).toEqual([
      4000, 620, 10, 570, 800, 700, 999,
    ]);

    const descending = await preview(app, { rules: [], sort: "releaseYear", order: "desc" });
    expect((descending.json() as GamesResponse).data.map((game) => game.appId)).toEqual([
      700, 800, 570, 10, 620, 4000, 999,
    ]);

    const lastPlayed = await preview(app, {
      rules: [],
      sort: "lastPlayed",
      order: "desc",
    });
    expect((lastPlayed.json() as GamesResponse).data.map((game) => game.appId)).toEqual([
      10, 620, 700, 570, 800, 999, 4000,
    ]);

    const appIdDesc = await preview(app, { rules: [], sort: "appId", order: "desc" });
    expect((appIdDesc.json() as GamesResponse).data.map((game) => game.appId)).toEqual([
      4000, 999, 800, 700, 620, 570, 10,
    ]);
  });

  it("pages the full match count instead of only the first page", async () => {
    const { app } = harness();
    const response = await preview(app, {
      rules: [],
      page: 2,
      pageSize: 2,
      sort: "appId",
      order: "asc",
    });
    const body = response.json() as GamesResponse;
    expect(body.data.map((game) => game.appId)).toEqual([620, 700]);
    expect(body.pagination).toEqual({ page: 2, pageSize: 2, totalItems: 7, totalPages: 4 });

    const lastPage = await preview(app, {
      rules: [],
      page: 4,
      pageSize: 2,
      sort: "appId",
      order: "asc",
    });
    expect((lastPage.json() as GamesResponse).data.map((game) => game.appId)).toEqual([4000]);
  });

  it("returns the same GameSummary rows as a normal Game list", async () => {
    const { app } = harness();
    const listed = await app.inject({
      method: "GET",
      url: "/api/games?pageSize=200&sort=appId&order=asc",
      headers: { host: HOST },
    });
    const evaluated = await preview(app, {
      rules: [],
      pageSize: 200,
      sort: "appId",
      order: "asc",
    });
    expect((evaluated.json() as GamesResponse).data).toEqual((listed.json() as GamesResponse).data);
  });

  it("returns up to three Tags sorted by votes descending in preview rows", async () => {
    const { app } = harness();
    const response = await preview(app, {
      rules: [{ prefix: "AND", field: "game", operator: "in", value: [10] }],
    });
    const body = response.json() as GamesResponse;
    expect(body.data[0]?.tags.map((tag) => tag.name)).toEqual(["FPS", "Shooter"]);
    expect(body.data[0]?.reviewScore).toBe(85);
    expect(body.data[0]?.reviewCount).toBe(1000);
  });

  it("reports dataAsOf from the latest completed Refresh", async () => {
    const { db, app } = harness();
    const empty = await preview(app, { rules: [] });
    expect((empty.json() as GamesResponse).meta).toEqual({ dataAsOf: null });

    db.raw
      .prepare(
        `UPDATE source_state SET status = 'ok', last_success_at = 1_700_000_100
         WHERE name = 'steam_local'`,
      )
      .run();
    const filled = await preview(app, { rules: [] });
    expect((filled.json() as GamesResponse).meta).toEqual({
      dataAsOf: new Date(1_700_000_100_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
  });
});

describe("POST /api/rules/preview validation", () => {
  it("returns the single error shape at the documented dotted paths", async () => {
    const { app } = harness();
    const invalid = await preview(app, {
      rules: [
        { prefix: "AND", field: "nope", operator: "is", value: "x" },
        { prefix: "AND", field: "playtime", operator: "is", value: 1 },
        { prefix: "and", field: "tag", operator: "has", value: "Co-op" },
        { prefix: "AND", field: "installed", operator: "is", value: "true" },
        { prefix: "AND", field: "game", operator: "in", value: [620, 620] },
      ],
    });
    expect(invalid.statusCode).toBe(422);
    const body = invalid.json() as {
      error: { code: string; message: string; details: { fieldErrors: Record<string, string> } };
    };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(body.error.details.fieldErrors).sort()).toEqual([
      "rules.0.field",
      "rules.1.operator",
      "rules.2.prefix",
      "rules.3.value",
      "rules.4.value",
    ]);
    expect(invalid.headers["x-request-id"]).toBeDefined();
  });

  it("rejects more than 100 Rules at rules", async () => {
    const { app } = harness();
    const rule = { prefix: "AND", field: "tag", operator: "has", value: "Co-op" };
    const response = await preview(app, { rules: Array.from({ length: 101 }, () => rule) });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { details: { fieldErrors: Record<string, string> } } };
    expect(body.error.details.fieldErrors).toHaveProperty("rules");
  });

  it("rejects an explicit null Rules value as the wrong JSON type", async () => {
    const { app } = harness();
    const response = await preview(app, { rules: null });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { details: { fieldErrors: Record<string, string> } } };
    expect(body.error.details.fieldErrors).toHaveProperty("rules");
  });

  it("rejects an invalid page, pageSize, sort, or order", async () => {
    const { app } = harness();
    const response = await preview(app, {
      rules: [],
      page: 0,
      pageSize: 500,
      sort: "tags",
      order: "up",
    });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { details: { fieldErrors: Record<string, string> } } };
    expect(Object.keys(body.error.details.fieldErrors).sort()).toEqual([
      "order",
      "page",
      "pageSize",
      "sort",
    ]);
  });

  it("accepts unknown vocabulary values and unknown Collection IDs, matching nothing", async () => {
    const { app } = harness();
    const response = await preview(app, {
      rules: [{ prefix: "AND", field: "tag", operator: "has", value: "Definitely Not A Tag" }],
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as GamesResponse).pagination.totalItems).toBe(0);

    for (const rules of [
      [{ prefix: "AND", field: "steamCollection", operator: "has", value: "uc-missing" }],
      [{ prefix: "AND", field: "steamCollection", operator: "has", value: "uc-dynamic" }],
      [{ prefix: "AND", field: "game", operator: "in", value: [123_456] }],
    ]) {
      const accepted = await preview(app, { rules });
      expect(accepted.statusCode).toBe(200);
      expect((accepted.json() as GamesResponse).pagination.totalItems).toBe(0);
    }
  });
});

describe("POST /api/rules/preview purity", () => {
  it("does not write to the database or read the clock", async () => {
    const { db, app } = harness();
    const tables = [
      "games",
      "tags",
      "game_tags",
      "steam_collections",
      "steam_collection_games",
      "storefront_appdetails",
      "steamspy_appdetails",
      "steam_review_summaries",
      "smart_collections",
      "rules",
    ];
    const snapshot = (): Record<string, number> =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          (db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
            .count,
        ]),
      );

    const before = snapshot();
    const changesBefore = (
      db.raw.prepare("SELECT total_changes() AS count").get() as { count: number }
    ).count;
    const first = await preview(app, {
      rules: [{ prefix: "AND", field: "playtime", operator: "gte", value: 600 }],
      sort: "playtime",
      order: "desc",
    });
    const second = await preview(app, {
      rules: [{ prefix: "AND", field: "playtime", operator: "gte", value: 600 }],
      sort: "playtime",
      order: "desc",
    });

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(snapshot()).toEqual(before);
    expect(
      (db.raw.prepare("SELECT total_changes() AS count").get() as { count: number }).count,
    ).toBe(changesBefore);
  });
});
