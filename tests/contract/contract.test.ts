import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../../src/server/db/database.ts";
import { createHttpApp } from "../../src/server/http/app.ts";
import type { ConfigRoutes } from "../../src/server/http/api-routes.ts";
import { SteamCollectionsRepository } from "../../src/server/library/collections.ts";
import { GamesRepository } from "../../src/server/library/games.ts";
import { RulePreviewRepository } from "../../src/server/library/rule-preview.ts";
import { RuleValuesRepository } from "../../src/server/library/rule-values.ts";
import { SmartCollectionsRepository } from "../../src/server/library/smart-collections.ts";
import { TagsRepository } from "../../src/server/library/tags.ts";
import { RefreshService } from "../../src/server/refresh/service.ts";
import { buildStatus } from "../../src/server/status.ts";
import type { SteamDiscovery } from "../../src/server/steam/discovery.ts";
import type { Config } from "../../src/shared/types.ts";
import { seedWorkedLibrary } from "../helpers/rule-db.ts";
import { TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;

interface SchemaDocument {
  definitions: Record<string, unknown>;
  [name: string]: unknown;
}

const document = JSON.parse(
  readFileSync(new URL("./schemas.json", import.meta.url), "utf8"),
) as SchemaDocument;
const { definitions, ...roots } = document;
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();

function validator(name: string): ValidateFunction {
  const cached = validators.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const root = roots[name] ?? definitions[name];
  if (root === undefined) {
    throw new Error(`No contract schema named ${name}`);
  }
  const compiled = ajv.compile({ definitions, ...(root as object) });
  validators.set(name, compiled);
  return compiled;
}

function expectValid(name: string, value: unknown, label: string): void {
  const validate = validator(name);
  const valid = validate(value);
  expect(valid, `${label}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

const spec = readFileSync(new URL("../../docs/specs/game-cat-v1.md", import.meta.url), "utf8");

/** The Nth fenced JSON block after an exact Markdown heading. */
function specExample(heading: string, occurrence = 0): unknown {
  const lines = spec.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    throw new Error(`Heading not found: ${heading}`);
  }
  let seen = 0;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (!lines[index]!.trim().startsWith("```json")) {
      continue;
    }
    if (seen !== occurrence) {
      seen += 1;
      index = skipFence(lines, index);
      continue;
    }
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor]!.trim() === "```") {
        return JSON.parse(body.join("\n"));
      }
      body.push(lines[cursor]!);
    }
    throw new Error(`Unclosed JSON block after ${heading}`);
  }
  throw new Error(`No JSON example after ${heading}`);
}

function skipFence(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === "```") {
      return index;
    }
  }
  return lines.length;
}

describe("documented JSON examples", () => {
  it("validates the §4.2 common objects", () => {
    expectValid("gameSummary", specExample("#### `GameSummary`"), "GameSummary");
    expectValid("gameDetail", specExample("#### `GameDetail`"), "GameDetail");
    expectValid("rule", specExample("#### `Rule`"), "Rule");
    expectValid("smartCollection", specExample("#### `SmartCollection`", 0), "SmartCollection");
    expectValid(
      "smartCollectionListItem",
      specExample("#### `SmartCollection`", 1),
      "SmartCollectionListItem",
    );
    expectValid(
      "steamCollectionSummary",
      specExample("#### `SteamCollectionSummary`"),
      "SteamCollectionSummary",
    );
    expectValid("errorDetail", specExample("#### `ErrorDetail`"), "ErrorDetail");
    expectValid("refreshRun", specExample("#### `RefreshRun`"), "RefreshRun");
    expectValid("status", specExample("#### `Status`"), "Status");
    expectValid("sourceHealth", specExample("#### `SourceHealth`"), "SourceHealth");
    expectValid("config", specExample("#### `Config`"), "Config");
    expectValid("steamAccount", specExample("#### `SteamAccount`"), "SteamAccount");
  });

  it("validates the paginated §4.3 list examples", () => {
    expectValid("tagsResponse", specExample("#### `GET /api/tags`"), "tags");
    expectValid("ruleValuesResponse", specExample("#### `GET /api/rule-values`"), "rule values");
  });

  it("enforces required, enum, nullable, and camelCase fields", () => {
    const game = specExample("#### `GameSummary`") as Record<string, unknown>;
    expectValid("gameSummary", game, "example");

    const missingName = { ...game };
    delete missingName.name;
    expect(validator("gameSummary")(missingName)).toBe(false);

    expect(validator("gameSummary")({ ...game, ownershipStatus: "owned " })).toBe(false);
    expect(validator("gameSummary")({ ...game, installed: "true" })).toBe(false);
    expect(validator("gameSummary")({ ...game, tags: null })).toBe(false);
    expect(validator("gameSummary")({ ...game, app_id: 620 })).toBe(false);
    expect(validator("gameSummary")({ ...game, reviewScore: null })).toBe(true);
  });
});

const discovery: SteamDiscovery = {
  root: "/fixture/Steam",
  state: "ready",
  accounts: [{ steamId64: TEST_STEAM_ID64, accountId: "39734272", personaName: "Player One" }],
  account: { steamId64: TEST_STEAM_ID64, accountId: "39734272", personaName: "Player One" },
  ambiguous: false,
  error: null,
};

interface Harness {
  db: AppDatabase;
  app: ReturnType<typeof createHttpApp>;
}

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

function harness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "game-cat-contract-"));
  dataDirs.push(dataDir);
  const db = openAppDatabase({ dataDir, steamWebApiConfigured: true });
  databases.push(db);
  seedWorkedLibrary(db.raw);

  const config: Config = {
    dataDir,
    steamRoot: "/fixture/Steam",
    steamId64: TEST_STEAM_ID64,
    port: PORT,
    listeningUrl: `http://${HOST}/`,
    openBrowser: false,
    logLevel: "info",
    steamApiKeySet: true,
    steamApiKeySource: "file",
  };
  const configRoutes: ConfigRoutes = {
    get: () => config,
    patch: () => ({ data: config, meta: { restartRequired: false } }),
    accounts: () => [
      { steamId64: TEST_STEAM_ID64, accountId: "39734272", personaName: "Player One" },
    ],
  };

  const refresh = new RefreshService({
    db: db.raw,
    steamRoot: null,
    steamId64: null,
    steamApiKey: null,
    sources: [],
    sleep: async () => {},
  });
  const app = createHttpApp({
    port: PORT,
    clientDir: null,
    logger: pino({ level: "silent" }),
    status: () =>
      buildStatus({
        discovery,
        steamApiKey: "SECRET_KEY",
        configuredSteamId64: TEST_STEAM_ID64,
        schemaVersion: db.schemaVersion,
        db: db.raw,
      }),
    library: {
      games: new GamesRepository(db.raw),
      collections: new SteamCollectionsRepository(db.raw),
      ruleValues: new RuleValuesRepository(db.raw),
      rulePreview: new RulePreviewRepository(db.raw),
      smartCollections: new SmartCollectionsRepository(db.raw),
      tags: new TagsRepository(db.raw),
      refresh,
    },
    config: configRoutes,
  });
  apps.push(app);
  return { db, app };
}

async function request(
  test: Harness,
  url: string,
  init: { method?: string; payload?: object } = {},
): Promise<{ statusCode: number; body: unknown }> {
  const response = await test.app.inject({
    method: (init.method ?? "GET") as "GET" | "POST" | "PATCH",
    url,
    headers: {
      host: HOST,
      ...(init.payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.payload === undefined ? {} : { payload: init.payload }),
  });
  return { statusCode: response.statusCode, body: response.json() };
}

describe("implemented handlers match the contract", () => {
  it("validates status, config, and the Steam Account list", async () => {
    const test = harness();

    const status = await request(test, "/api/status");
    expect(status.statusCode).toBe(200);
    expectValid("statusResponse", status.body, "GET /api/status");

    const config = await request(test, "/api/config");
    expectValid("configResponse", config.body, "GET /api/config");

    const patched = await request(test, "/api/config", { method: "PATCH", payload: {} });
    expectValid("configPatchResponse", patched.body, "PATCH /api/config");

    const accounts = await request(test, "/api/steam/accounts");
    expectValid("steamAccountsResponse", accounts.body, "GET /api/steam/accounts");
  });

  it("validates Game, Tag, Rule-value, and Steam Collection responses", async () => {
    const test = harness();

    expectValid(
      "gamesResponse",
      (await request(test, "/api/games?pageSize=200")).body,
      "GET /api/games",
    );
    expectValid(
      "gameDetailResponse",
      (await request(test, "/api/games/10")).body,
      "GET /api/games/10",
    );
    expectValid("tagsResponse", (await request(test, "/api/tags")).body, "GET /api/tags");
    expectValid(
      "ruleValuesResponse",
      (await request(test, "/api/rule-values?field=genre")).body,
      "GET /api/rule-values",
    );
    expectValid(
      "steamCollectionsResponse",
      (await request(test, "/api/steam-collections")).body,
      "GET /api/steam-collections",
    );
    expectValid(
      "steamCollectionResponse",
      (await request(test, "/api/steam-collections/favorite")).body,
      "GET /api/steam-collections/favorite",
    );
    expectValid(
      "steamCollectionGamesResponse",
      (await request(test, "/api/steam-collections/favorite/games")).body,
      "GET /api/steam-collections/favorite/games",
    );
  });

  it("validates Smart Collection create, read, list, and games responses", async () => {
    const test = harness();
    const created = await request(test, "/api/smart-collections", {
      method: "POST",
      payload: {
        name: "Contract Collection",
        rules: [{ prefix: "AND", field: "tag", operator: "has", value: "Co-op" }],
      },
    });
    expect(created.statusCode).toBe(201);
    expectValid("smartCollectionResponse", created.body, "POST /api/smart-collections");
    const id = (created.body as { data: { id: string } }).data.id;

    expectValid(
      "smartCollectionResponse",
      (await request(test, `/api/smart-collections/${id}`)).body,
      "GET /api/smart-collections/{id}",
    );
    expectValid(
      "smartCollectionsResponse",
      (await request(test, "/api/smart-collections")).body,
      "GET /api/smart-collections",
    );
    expectValid(
      "smartCollectionGamesResponse",
      (await request(test, `/api/smart-collections/${id}/games`)).body,
      "GET /api/smart-collections/{id}/games",
    );
  });

  it("validates Refresh start, poll, and the error envelope", async () => {
    const test = harness();
    const started = await request(test, "/api/refresh", {
      method: "POST",
      payload: { scope: "metadata", mode: "fetch" },
    });
    expect(started.statusCode).toBe(202);
    expectValid("refreshStartResponse", started.body, "POST /api/refresh");
    const id = (started.body as { data: { id: string } }).data.id;

    expectValid(
      "refreshRunResponse",
      (await request(test, `/api/refresh/${id}`)).body,
      "GET /api/refresh/{id}",
    );

    const missing = await request(test, "/api/games/999999");
    expect(missing.statusCode).toBe(404);
    expectValid("errorResponse", missing.body, "404 error");
    expect((missing.body as { error: { requestId?: string } }).error.requestId).toBeTruthy();

    const invalid = await request(test, "/api/rules/preview", {
      method: "POST",
      payload: { rules: null },
    });
    expect(invalid.statusCode).toBe(422);
    expectValid("errorResponse", invalid.body, "422 error");
  });
});
