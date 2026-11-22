import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
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
import { TIMESTAMP_PATTERN, type ResponseSchemaName } from "../../src/shared/http-schemas.ts";
import type { Config } from "../../src/shared/types.ts";
import { seedWorkedLibrary } from "../helpers/rule-db.ts";
import { TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;

const discovery: SteamDiscovery = {
  root: "/fixture/Steam",
  state: "ready",
  accounts: [{ steamId64: TEST_STEAM_ID64, accountId: "39734272", personaName: "Player One" }],
  account: { steamId64: TEST_STEAM_ID64, accountId: "39734272", personaName: "Player One" },
  ambiguous: false,
  error: null,
};

export interface ContractServer {
  db: AppDatabase;
  app: ReturnType<typeof createHttpApp>;
  refresh: RefreshService;
  close(): Promise<void>;
}

/** A real HTTP boundary over the worked §5.8 Library, with no fixture server. */
export function startContractServer(): ContractServer {
  const dataDir = mkdtempSync(join(tmpdir(), "game-cat-contract-"));
  const db = openAppDatabase({ dataDir, steamWebApiConfigured: true });
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

  return {
    db,
    app,
    refresh,
    async close() {
      await refresh.shutdown();
      await app.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: unknown;
}

async function call(
  server: ContractServer,
  url: string,
  init: { method?: string; payload?: object } = {},
): Promise<Response> {
  const response = await server.app.inject({
    method: (init.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE",
    url,
    headers: {
      host: HOST,
      ...(init.payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.payload === undefined ? {} : { payload: init.payload }),
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    // A 204 has no body, so `inject().json()` would throw.
    body: response.body === "" ? undefined : response.json(),
  };
}

export interface CapturedResponse {
  schema?: ResponseSchemaName;
  statusCode: number;
  /** Only the documented `Location` header is part of the response contract. */
  headers?: { location: string };
  body?: unknown;
}

export type CapturedResponses = Record<string, CapturedResponse>;

const TIMESTAMP = new RegExp(TIMESTAMP_PATTERN);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** A `Location` embeds a generated ID, so normalise the ID inside the path. */
function normalizeLocation(location: string): string {
  return location.replace(UUID_IN_TEXT, "00000000-0000-4000-8000-000000000000");
}

/**
 * Replace the values that legitimately change between captures with fixed,
 * schema-valid placeholders. Everything else stays exact: a field that moves,
 * disappears, or changes type fails the golden comparison.
 */
export function normalizeContractValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeContractValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key === "requestId") {
          return [key, "request-id"];
        }
        if (key === "dataDir") {
          return [key, "/contract/data"];
        }
        return [key, normalizeContractValue(child)];
      }),
    );
  }
  if (typeof value === "string") {
    if (TIMESTAMP.test(value)) {
      return "2000-01-01T00:00:00Z";
    }
    if (UUID.test(value)) {
      return "00000000-0000-4000-8000-000000000000";
    }
  }
  return value;
}

/**
 * Exercise every implemented endpoint in a fixed order. Both the contract
 * suite and `npm run contract:golden` use this sequence, so the oracle and the
 * captured fixtures cannot disagree about what the API returns.
 */
export async function captureContractResponses(): Promise<CapturedResponses> {
  const server = startContractServer();
  const responses: CapturedResponses = {};

  async function record(
    name: string,
    schema: ResponseSchemaName | null,
    response: Promise<Response>,
  ): Promise<unknown> {
    const result = await response;
    const location = result.headers.location;
    responses[name] = {
      ...(schema === null ? {} : { schema }),
      statusCode: result.statusCode,
      ...(typeof location === "string" ? { headers: { location: normalizeLocation(location) } } : {}),
      ...(result.body === undefined ? {} : { body: normalizeContractValue(result.body) }),
    };
    return result.body;
  }

  try {
    await record("status", "statusResponse", call(server, "/api/status"));
    await record("config", "configResponse", call(server, "/api/config"));
    await record(
      "config-patch",
      "configPatchResponse",
      call(server, "/api/config", { method: "PATCH", payload: {} }),
    );
    await record("steam-accounts", "steamAccountsResponse", call(server, "/api/steam/accounts"));

    await record("games", "gamesResponse", call(server, "/api/games?pageSize=200"));
    await record("game-detail", "gameDetailResponse", call(server, "/api/games/10"));
    await record("game-detail-seeded-999", "gameDetailResponse", call(server, "/api/games/999"));
    await record("tags", "tagsResponse", call(server, "/api/tags"));
    await record("rule-values", "ruleValuesResponse", call(server, "/api/rule-values?field=genre"));

    await record(
      "steam-collections",
      "steamCollectionsResponse",
      call(server, "/api/steam-collections"),
    );
    await record(
      "steam-collection",
      "steamCollectionResponse",
      call(server, "/api/steam-collections/favorite"),
    );
    await record(
      "steam-collection-games",
      "steamCollectionGamesResponse",
      call(server, "/api/steam-collections/favorite/games"),
    );
    await record(
      "steam-collection-games-dynamic",
      "steamCollectionGamesResponse",
      call(server, "/api/steam-collections/uc-dynamic/games"),
    );

    await record(
      "rules-preview",
      "gamesResponse",
      call(server, "/api/rules/preview", {
        method: "POST",
        payload: {
          rules: [{ prefix: "AND", field: "tag", operator: "has", value: "Co-op" }],
          pageSize: 200,
        },
      }),
    );

    const created = (await record(
      "smart-collection-create",
      "smartCollectionResponse",
      call(server, "/api/smart-collections", {
        method: "POST",
        payload: {
          name: "Contract Collection",
          rules: [{ prefix: "AND", field: "tag", operator: "has", value: "Co-op" }],
        },
      }),
    )) as { data: { id: string } };
    const smartCollectionId = created.data.id;

    await record(
      "smart-collection-name-conflict",
      "errorResponse",
      call(server, "/api/smart-collections", {
        method: "POST",
        payload: {
          name: "Contract Collection",
          rules: [{ prefix: "AND", field: "tag", operator: "has", value: "Co-op" }],
        },
      }),
    );

    await record(
      "smart-collection",
      "smartCollectionResponse",
      call(server, `/api/smart-collections/${smartCollectionId}`),
    );
    await record(
      "smart-collections",
      "smartCollectionsResponse",
      call(server, "/api/smart-collections"),
    );
    await record(
      "smart-collection-games",
      "smartCollectionGamesResponse",
      call(server, `/api/smart-collections/${smartCollectionId}/games`),
    );
    await record(
      "smart-collection-patch",
      "smartCollectionResponse",
      call(server, `/api/smart-collections/${smartCollectionId}`, {
        method: "PATCH",
        payload: { name: "Renamed Contract Collection" },
      }),
    );
    await record(
      "smart-collection-delete",
      null,
      call(server, `/api/smart-collections/${smartCollectionId}`, { method: "DELETE" }),
    );
    await record(
      "smart-collection-delete-again",
      "errorResponse",
      call(server, `/api/smart-collections/${smartCollectionId}`, { method: "DELETE" }),
    );

    const started = (await record(
      "refresh-start",
      "refreshStartResponse",
      call(server, "/api/refresh", {
        method: "POST",
        payload: { scope: "metadata", mode: "fetch" },
      }),
    )) as { data: { id: string } };
    const refreshId = started.data.id;

    await server.refresh.waitForIdle();
    await record("refresh-run", "refreshRunResponse", call(server, `/api/refresh/${refreshId}`));

    await record("not-found", "errorResponse", call(server, "/api/games/999999"));
    await record(
      "validation-error",
      "errorResponse",
      call(server, "/api/rules/preview", { method: "POST", payload: { rules: null } }),
    );
    await record(
      "smart-collection-not-found",
      "errorResponse",
      call(server, "/api/smart-collections/missing"),
    );

    return responses;
  } finally {
    await server.close();
  }
}
