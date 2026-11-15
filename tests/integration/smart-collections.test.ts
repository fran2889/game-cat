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
import { SmartCollectionsRepository } from "../../src/server/library/smart-collections.ts";
import { TagsRepository } from "../../src/server/library/tags.ts";
import { RefreshService } from "../../src/server/refresh/service.ts";
import type { Rule } from "../../src/shared/rules.ts";
import type {
  SmartCollection,
  SmartCollectionGamesResponse,
  SmartCollectionsResponse,
} from "../../src/shared/smart-collections.ts";
import type { GamesResponse, Status } from "../../src/shared/types.ts";
import { WORKED_CASES } from "../helpers/rule-fixture.ts";
import { seedWorkedLibrary } from "../helpers/rule-db.ts";

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const dataDirs: string[] = [];
const databases: AppDatabase[] = [];
const apps: Array<ReturnType<typeof createHttpApp>> = [];

interface Harness {
  db: AppDatabase;
  app: ReturnType<typeof createHttpApp>;
  tick(seconds: number): number;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-smart-collections-"));
  dataDirs.push(dir);
  const db = openAppDatabase({ dataDir: dir, steamWebApiConfigured: false });
  databases.push(db);
  seedWorkedLibrary(db.raw);

  let clock = 1_700_000_000;
  const refresh = new RefreshService({
    db: db.raw,
    steamRoot: null,
    steamId64: null,
    now: () => clock,
  });
  const smartCollections = new SmartCollectionsRepository(db.raw, { now: () => clock });
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
      smartCollections,
      refresh,
    },
  });
  apps.push(app);

  return {
    db,
    app,
    tick(seconds) {
      clock += seconds;
      return clock;
    },
  };
}

async function create(app: ReturnType<typeof createHttpApp>, body: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/smart-collections",
    headers: { host: HOST, "content-type": "application/json" },
    payload: body as object,
  });
}

async function patch(app: ReturnType<typeof createHttpApp>, id: string, body: unknown) {
  return app.inject({
    method: "PATCH",
    url: `/api/smart-collections/${id}`,
    headers: { host: HOST, "content-type": "application/json" },
    payload: body as object,
  });
}

async function get(app: ReturnType<typeof createHttpApp>, url: string) {
  return app.inject({ method: "GET", url, headers: { host: HOST } });
}

async function remove(app: ReturnType<typeof createHttpApp>, id: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/smart-collections/${id}`,
    headers: { host: HOST },
  });
}

function created(response: Awaited<ReturnType<typeof create>>): SmartCollection {
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: SmartCollection }).data;
}

const COOP: Rule = { prefix: "AND", field: "tag", operator: "has", value: "Co-op" };
const SHORT: Rule = { prefix: "AND", field: "playtime", operator: "lt", value: 600 };

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

describe("POST /api/smart-collections", () => {
  it("creates a UUID Smart Collection with trimmed name, ordered Rules, and Location", async () => {
    const { db, app, tick } = harness();
    tick(10);
    const response = await create(app, { name: "  Short co-op games  ", rules: [COOP, SHORT] });

    expect(response.statusCode).toBe(201);
    const collection = (response.json() as { data: SmartCollection }).data;
    expect(collection.id).toMatch(UUID_V4);
    expect(response.headers.location).toBe(`/api/smart-collections/${collection.id}`);
    expect(collection).toMatchObject({
      id: collection.id,
      name: "Short co-op games",
      rules: [COOP, SHORT],
      createdAt: "2023-11-14T22:13:30Z",
      updatedAt: "2023-11-14T22:13:30Z",
    });
    expect(collection.rules.some((rule) => "id" in rule)).toBe(false);

    const rows = db.raw
      .prepare(
        "SELECT position, prefix, field, operator, value_json FROM rules WHERE smart_collection_id = ? ORDER BY position",
      )
      .all(collection.id) as Array<{ position: number; value_json: string }>;
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
    expect(JSON.parse(rows[0]!.value_json)).toBe("Co-op");
    expect(JSON.parse(rows[1]!.value_json)).toBe(600);

    const fetched = await get(app, `/api/smart-collections/${collection.id}`);
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { data: SmartCollection }).data).toEqual(collection);
  });

  it("defaults rules to an empty array", async () => {
    const { app } = harness();
    const collection = created(await create(app, { name: "Everything" }));
    expect(collection.rules).toEqual([]);
  });

  it("rejects missing, blank, over-long, and control-bearing names", async () => {
    const { app } = harness();
    for (const body of [
      {},
      { name: "   " },
      { name: "a".repeat(81) },
      { name: "bad\u0000name" },
      { name: 42 },
    ]) {
      const response = await create(app, body);
      expect(response.statusCode).toBe(422);
      const error = response.json() as {
        error: { code: string; details: { fieldErrors: object } };
      };
      expect(error.error.code).toBe("VALIDATION_ERROR");
      expect(error.error.details.fieldErrors).toHaveProperty("name");
    }
  });

  it("counts 80 name code points, not UTF-16 units", async () => {
    const { app } = harness();
    const emoji = "😀".repeat(80);
    expect(created(await create(app, { name: emoji })).name).toBe(emoji);

    const tooLong = await create(app, { name: "😀".repeat(81) });
    expect(tooLong.statusCode).toBe(422);
  });

  it("accepts 0 and 100 Rules", async () => {
    const { app } = harness();
    expect(created(await create(app, { name: "None", rules: [] })).rules).toHaveLength(0);

    const hundred = Array.from({ length: 100 }, () => COOP);
    expect(created(await create(app, { name: "Hundred", rules: hundred })).rules).toHaveLength(100);

    const tooMany = await create(app, { name: "Too many", rules: Array(101).fill(COOP) });
    expect(tooMany.statusCode).toBe(422);
    expect(
      (tooMany.json() as { error: { details: { fieldErrors: Record<string, string> } } }).error
        .details.fieldErrors,
    ).toHaveProperty("rules");
  });

  it("maps invalid Rule errors to dotted paths", async () => {
    const { app } = harness();
    const response = await create(app, {
      name: "Bad rules",
      rules: [{ prefix: "XOR", field: "notAField", operator: "nope", value: "" }],
    });
    expect(response.statusCode).toBe(422);
    const fieldErrors = (
      response.json() as { error: { details: { fieldErrors: Record<string, string> } } }
    ).error.details.fieldErrors;
    expect(fieldErrors).toHaveProperty("rules.0.prefix");
    expect(fieldErrors).toHaveProperty("rules.0.field");
    expect(fieldErrors).toHaveProperty("rules.0.operator");
  });

  it("enforces the 16 KiB serialized Rule value cap", async () => {
    const { app } = harness();
    const oversized = Array.from({ length: 1000 }, (_, index) => 1_000_000_000_000_000 + index);
    const response = await create(app, {
      name: "Huge value",
      rules: [{ prefix: "AND", field: "game", operator: "in", value: oversized }],
    });
    expect(response.statusCode).toBe(422);
    const fieldErrors = (
      response.json() as { error: { details: { fieldErrors: Record<string, string> } } }
    ).error.details.fieldErrors;
    expect(fieldErrors["rules.0.value"]).toMatch(/16 KiB/);
  });

  it("returns NAME_CONFLICT with the conflicting id for case-insensitive duplicates", async () => {
    const { app } = harness();
    const first = created(await create(app, { name: "Co-op" }));

    const duplicate = await create(app, { name: "  co-OP  " });
    expect(duplicate.statusCode).toBe(409);
    const error = duplicate.json() as {
      error: { code: string; details: { conflictingId: string } };
    };
    expect(error.error.code).toBe("NAME_CONFLICT");
    expect(error.error.details.conflictingId).toBe(first.id);
  });

  it("uses the shared NFC name key for duplicates", async () => {
    const { app } = harness();
    const first = created(await create(app, { name: "Caf\u00e9" }));
    const duplicate = await create(app, { name: "cafe\u0301" });
    expect(duplicate.statusCode).toBe(409);
    expect(
      (duplicate.json() as { error: { details: { conflictingId: string } } }).error.details
        .conflictingId,
    ).toBe(first.id);
  });
});

describe("PATCH /api/smart-collections/{id}", () => {
  it("replaces name and the full Rules array with contiguous positions", async () => {
    const { db, app, tick } = harness();
    const collection = created(await create(app, { name: "Before", rules: [COOP, SHORT, COOP] }));
    const originalUpdatedAt = collection.updatedAt;
    tick(30);

    const response = await patch(app, collection.id, {
      name: "After",
      rules: [SHORT, { prefix: "OR", field: "tag", operator: "has", value: "Puzzle" }],
    });
    expect(response.statusCode).toBe(200);
    const updated = (response.json() as { data: SmartCollection }).data;
    expect(updated.id).toBe(collection.id);
    expect(updated.name).toBe("After");
    expect(updated.rules).toEqual([
      SHORT,
      { prefix: "OR", field: "tag", operator: "has", value: "Puzzle" },
    ]);
    expect(updated.createdAt).toBe(collection.createdAt);
    expect(updated.updatedAt).not.toBe(originalUpdatedAt);

    const rows = db.raw
      .prepare("SELECT position FROM rules WHERE smart_collection_id = ? ORDER BY position ASC")
      .all(collection.id) as Array<{ position: number }>;
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
  });

  it("allows a case-only rename on the same row", async () => {
    const { app } = harness();
    const collection = created(await create(app, { name: "Co-op" }));

    const response = await patch(app, collection.id, { name: "CO-OP" });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: SmartCollection }).data).toMatchObject({
      id: collection.id,
      name: "CO-OP",
    });
  });

  it("rejects a rename onto another Collection with NAME_CONFLICT", async () => {
    const { app } = harness();
    const first = created(await create(app, { name: "First" }));
    const second = created(await create(app, { name: "Second" }));

    const response = await patch(app, second.id, { name: "  first " });
    expect(response.statusCode).toBe(409);
    expect(
      (response.json() as { error: { details: { conflictingId: string } } }).error.details
        .conflictingId,
    ).toBe(first.id);
  });

  it("leaves the old name and Rules untouched when the new Rules are invalid", async () => {
    const { db, app } = harness();
    const collection = created(await create(app, { name: "Stable", rules: [COOP] }));

    const response = await patch(app, collection.id, {
      name: "Renamed",
      rules: [{ prefix: "AND", field: "tag", operator: "has", value: "" }],
    });
    expect(response.statusCode).toBe(422);
    const fieldErrors = (
      response.json() as { error: { details: { fieldErrors: Record<string, string> } } }
    ).error.details.fieldErrors;
    expect(fieldErrors).toHaveProperty("rules.0.value");

    const after = (
      (await get(app, `/api/smart-collections/${collection.id}`)).json() as {
        data: SmartCollection;
      }
    ).data;
    expect(after).toEqual(collection);
    const row = db.raw
      .prepare("SELECT name, updated_at FROM smart_collections WHERE id = ?")
      .get(collection.id) as { name: string; updated_at: number };
    expect(row.name).toBe("Stable");
  });

  it("requires at least one of name or rules", async () => {
    const { app } = harness();
    const collection = created(await create(app, { name: "Thing" }));
    const response = await patch(app, collection.id, {});
    expect(response.statusCode).toBe(422);
    expect(
      (response.json() as { error: { details: { fieldErrors: object } } }).error.details
        .fieldErrors,
    ).toHaveProperty("body");
  });

  it("returns 404 for an unknown id", async () => {
    const { app } = harness();
    const response = await patch(app, "00000000-0000-4000-8000-000000000000", {
      name: "Missing",
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });
});

describe("GET /api/smart-collections", () => {
  it("lists name-sorted items with ruleCount and evaluated matchCount", async () => {
    const { app } = harness();
    const beta = created(await create(app, { name: "Beta", rules: [COOP, SHORT] }));
    const alpha = created(await create(app, { name: "alpha", rules: [COOP] }));
    const gamma = created(await create(app, { name: "Gamma", rules: [] }));

    const response = await get(app, "/api/smart-collections");
    expect(response.statusCode).toBe(200);
    const body = response.json() as SmartCollectionsResponse;
    expect(body.pagination).toEqual({ page: 1, pageSize: 60, totalItems: 3, totalPages: 1 });
    expect(body.data.map((item) => item.name)).toEqual(["alpha", "Beta", "Gamma"]);
    expect(body.data.map((item) => item.id)).toEqual([alpha.id, beta.id, gamma.id]);
    expect(body.data.map((item) => item.ruleCount)).toEqual([1, 2, 0]);
    expect(body.data.map((item) => item.matchCount)).toEqual([1, 0, 7]);
    expect(body.data[0]).toEqual({
      id: alpha.id,
      name: alpha.name,
      ruleCount: 1,
      matchCount: 1,
      createdAt: alpha.createdAt,
      updatedAt: alpha.updatedAt,
    });
  });

  it("sorts by updatedAt and pages", async () => {
    const { app, tick } = harness();
    const first = created(await create(app, { name: "First" }));
    tick(10);
    const second = created(await create(app, { name: "Second" }));
    tick(10);
    const third = created(await create(app, { name: "Third" }));

    const descending = await get(
      app,
      "/api/smart-collections?sort=updatedAt&order=desc&pageSize=2",
    );
    const body = descending.json() as SmartCollectionsResponse;
    expect(body.data.map((item) => item.id)).toEqual([third.id, second.id]);
    expect(body.pagination).toEqual({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });

    const secondPage = await get(
      app,
      "/api/smart-collections?sort=updatedAt&order=desc&pageSize=2&page=2",
    );
    expect((secondPage.json() as SmartCollectionsResponse).data.map((item) => item.id)).toEqual([
      first.id,
    ]);
  });

  it("validates sort, order, page, and pageSize", async () => {
    const { app } = harness();
    for (const query of ["sort=nope", "order=nope", "page=0", "pageSize=201"]) {
      const response = await get(app, `/api/smart-collections?${query}`);
      expect(response.statusCode).toBe(422);
    }
  });

  it("computes every matchCount in one Library pass, without per-Collection requests", async () => {
    const { db, app } = harness();
    for (let index = 0; index < 5; index += 1) {
      created(await create(app, { name: `Collection ${index}`, rules: [COOP] }));
    }

    let libraryReads = 0;
    const originalPrepare = db.raw.prepare.bind(db.raw);
    (db.raw as unknown as { prepare(sql: string): unknown }).prepare = (sql: string) => {
      if (sql.includes("FROM v_games")) {
        libraryReads += 1;
      }
      return originalPrepare(sql);
    };
    try {
      const response = await get(app, "/api/smart-collections?pageSize=200");
      expect(response.statusCode).toBe(200);
      expect((response.json() as SmartCollectionsResponse).data).toHaveLength(5);
    } finally {
      (db.raw as unknown as { prepare: typeof originalPrepare }).prepare = originalPrepare;
    }
    expect(libraryReads).toBe(1);
  });

  it("returns an empty 200 list and the Create CTA contract", async () => {
    const { app } = harness();
    const response = await get(app, "/api/smart-collections");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [],
      pagination: { page: 1, pageSize: 60, totalItems: 0, totalPages: 0 },
    });
  });
});

describe("GET /api/smart-collections/{id}/games", () => {
  it("returns the same membership as preview for every worked case", async () => {
    const { app } = harness();
    for (const worked of WORKED_CASES.slice(0, 12)) {
      const collection = created(
        await create(app, { name: `Case ${worked.number}`, rules: worked.rules }),
      );
      const saved = await get(
        app,
        `/api/smart-collections/${collection.id}/games?pageSize=200&sort=appId&order=asc`,
      );
      const preview = await app.inject({
        method: "POST",
        url: "/api/rules/preview",
        headers: { host: HOST, "content-type": "application/json" },
        payload: { rules: worked.rules, pageSize: 200, sort: "appId", order: "asc" },
      });
      expect(saved.statusCode).toBe(200);
      expect((saved.json() as SmartCollectionGamesResponse).data).toEqual(
        (preview.json() as GamesResponse).data,
      );
    }
  });

  it("returns list matchCount equal to the saved games totalItems", async () => {
    const { app } = harness();
    for (const worked of WORKED_CASES) {
      created(await create(app, { name: `Parity ${worked.number}`, rules: worked.rules }));
    }
    const list = (
      await get(app, "/api/smart-collections?pageSize=200")
    ).json() as SmartCollectionsResponse;
    for (const item of list.data) {
      const games = (
        await get(app, `/api/smart-collections/${item.id}/games?pageSize=200`)
      ).json() as SmartCollectionGamesResponse;
      expect(item.matchCount).toBe(games.pagination.totalItems);
    }
  });

  it("pages and sorts like preview and reports dataAsOf", async () => {
    const { db, app } = harness();
    const collection = created(await create(app, { name: "All", rules: [] }));
    db.raw
      .prepare(
        `INSERT INTO refresh_runs (scope, mode, status, started_at, finished_at, done)
         VALUES ('library', NULL, 'succeeded', 1_700_000_000, 1_700_000_100, 7)`,
      )
      .run();

    const saved = await get(
      app,
      `/api/smart-collections/${collection.id}/games?pageSize=2&page=2&sort=appId&order=asc`,
    );
    const body = saved.json() as SmartCollectionGamesResponse;
    expect(body.data.map((game) => game.appId)).toEqual([620, 700]);
    expect(body.pagination).toEqual({ page: 2, pageSize: 2, totalItems: 7, totalPages: 4 });
    expect(body.meta).toEqual({ dataAsOf: "2023-11-14T22:15:00Z" });
  });

  it("returns 200 with an empty list when nothing matches", async () => {
    const { app } = harness();
    const collection = created(
      await create(app, {
        name: "None",
        rules: [{ prefix: "AND", field: "tag", operator: "has", value: "Horror" }],
      }),
    );
    const response = await get(app, `/api/smart-collections/${collection.id}/games`);
    expect(response.statusCode).toBe(200);
    expect((response.json() as SmartCollectionGamesResponse).data).toEqual([]);
    expect((response.json() as SmartCollectionGamesResponse).pagination.totalItems).toBe(0);
  });

  it("returns 404 for an unknown Collection", async () => {
    const { app } = harness();
    const response = await get(
      app,
      "/api/smart-collections/00000000-0000-4000-8000-000000000000/games",
    );
    expect(response.statusCode).toBe(404);
  });
});

describe("DELETE /api/smart-collections/{id}", () => {
  it("returns 204, cascades Rules, and treats a retry as 404", async () => {
    const { db, app } = harness();
    const collection = created(await create(app, { name: "Delete me", rules: [COOP, SHORT] }));

    const response = await remove(app, collection.id);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");

    const rules = db.raw
      .prepare("SELECT COUNT(*) AS count FROM rules WHERE smart_collection_id = ?")
      .get(collection.id) as { count: number };
    expect(rules.count).toBe(0);
    expect((await get(app, `/api/smart-collections/${collection.id}`)).statusCode).toBe(404);

    expect((await remove(app, collection.id)).statusCode).toBe(404);
  });
});
