/**
 * The single source of truth for API response shapes.
 *
 * Fastify serialises responses from these schemas, and the contract suite
 * validates captured golden responses against them. Request validation lives
 * in `src/server/http/schemas.ts`; only wire-facing response shapes belong here.
 */

import { RULE_FIELDS, RULE_OPERATORS, RULE_PREFIXES } from "./rules.ts";
import {
  LIBRARY_SCAN_STATUSES,
  LOG_LEVELS,
  OWNERSHIP_STATES,
  OWNERSHIP_STATUSES,
  REFRESH_MODES,
  REFRESH_SCOPES,
  REFRESH_STATUSES,
  SOURCE_ORDER,
  SOURCE_STATUSES,
  STEAM_API_KEY_SOURCES,
  STEAM_COLLECTION_KINDS,
  STEAM_STATES,
} from "./types.ts";

export const TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$";

export const TAGS_STATUSES = ["ok", "missing", "stale", "error"] as const;
export const METADATA_STATUSES = ["ok", "unavailable", "missing", "stale", "error"] as const;

export type TagsStatus = (typeof TAGS_STATUSES)[number];
export type MetadataStatus = (typeof METADATA_STATUSES)[number];

const nullableTimestamp = {
  anyOf: [{ $ref: "#/definitions/timestamp" }, { type: "null" }],
};

const pagination = {
  type: "object",
  required: ["page", "pageSize", "totalItems", "totalPages"],
  properties: {
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 200 },
    totalItems: { type: "integer", minimum: 0 },
    totalPages: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

/** `/api/steam/accounts` is a single page sized to the full Account list. */
const singlePagePagination = {
  type: "object",
  required: ["page", "pageSize", "totalItems", "totalPages"],
  properties: {
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1 },
    totalItems: { type: "integer", minimum: 0 },
    totalPages: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

const timestamp = {
  type: "string",
  pattern: TIMESTAMP_PATTERN,
};

const gameTag = {
  type: "object",
  required: ["name", "votes"],
  properties: {
    name: { type: "string", minLength: 1 },
    votes: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

const tagSummary = {
  type: "object",
  required: ["name", "gameCount"],
  properties: {
    name: { type: "string", minLength: 1 },
    gameCount: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
};

const ruleValue = {
  type: "object",
  required: ["value", "gameCount"],
  properties: {
    value: { type: "string", minLength: 1 },
    gameCount: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
};

/**
 * `anyOf` rather than a multi-type `type` array because fast-json-stringify would
 * otherwise serialise an integer array as a comma-separated string.
 */
const rule = {
  type: "object",
  required: ["prefix", "field", "operator", "value"],
  properties: {
    prefix: { type: "string", enum: [...RULE_PREFIXES] },
    field: { type: "string", enum: [...RULE_FIELDS] },
    operator: { type: "string", enum: [...RULE_OPERATORS] },
    value: {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "array", items: { type: "integer", minimum: 1 } },
      ],
    },
  },
  additionalProperties: false,
};

const gamePlatforms = {
  type: "object",
  properties: {
    windows: { type: "boolean" },
    mac: { type: "boolean" },
    linux: { type: "boolean" },
  },
  additionalProperties: false,
};

const gameMetadata = {
  type: "object",
  required: ["tagsStatus", "storeStatus", "reviewStatus"],
  properties: {
    tagsStatus: { type: "string", enum: [...TAGS_STATUSES] },
    storeStatus: { type: "string", enum: [...METADATA_STATUSES] },
    reviewStatus: { type: "string", enum: [...METADATA_STATUSES] },
    tagsFetchedAt: { $ref: "#/definitions/nullableTimestamp" },
    storeFetchedAt: { $ref: "#/definitions/nullableTimestamp" },
    reviewFetchedAt: { $ref: "#/definitions/nullableTimestamp" },
  },
  additionalProperties: false,
};

const gameSummary = {
  type: "object",
  required: [
    "appId",
    "name",
    "ownershipStatus",
    "installed",
    "playtimeMinutes",
    "lastPlayedAt",
    "releaseYear",
    "metacriticScore",
    "reviewScore",
    "reviewTier",
    "reviewCount",
    "type",
    "platforms",
    "tags",
    "metadata",
  ],
  properties: {
    appId: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1 },
    ownershipStatus: { type: "string", enum: [...OWNERSHIP_STATUSES] },
    installed: { type: ["boolean", "null"] },
    playtimeMinutes: { type: "integer", minimum: 0 },
    lastPlayedAt: { $ref: "#/definitions/nullableTimestamp" },
    releaseYear: { type: ["integer", "null"], minimum: 1000, maximum: 9999 },
    metacriticScore: { type: ["integer", "null"], minimum: 0, maximum: 100 },
    reviewScore: { type: ["integer", "null"], minimum: 0, maximum: 100 },
    reviewTier: { type: ["string", "null"] },
    reviewCount: { type: ["integer", "null"], minimum: 0 },
    type: { type: ["string", "null"] },
    platforms: {
      anyOf: [{ $ref: "#/definitions/gamePlatforms" }, { type: "null" }],
    },
    tags: {
      type: "array",
      maxItems: 3,
      items: { $ref: "#/definitions/gameTag" },
    },
    metadata: { $ref: "#/definitions/gameMetadata" },
  },
  additionalProperties: false,
};

/** A detail is a summary plus the fields only `GET /api/games/{appId}` returns. */
const gameDetail = {
  type: "object",
  required: [
    ...gameSummary.required,
    "releaseDateRaw",
    "developers",
    "publishers",
    "genres",
    "categories",
    "steamCollections",
    "sizeOnDiskBytes",
  ],
  properties: {
    ...gameSummary.properties,
    releaseDateRaw: { type: ["string", "null"] },
    developers: { type: "array", items: { type: "string" } },
    publishers: { type: "array", items: { type: "string" } },
    genres: { type: "array", items: { type: "string" } },
    categories: { type: "array", items: { type: "string" } },
    // Detail returns the full tag list; the summary list is capped at three.
    tags: { type: "array", items: { $ref: "#/definitions/gameTag" } },
    steamCollections: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "kind"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          kind: { type: "string", enum: [...STEAM_COLLECTION_KINDS] },
        },
        additionalProperties: false,
      },
    },
    sizeOnDiskBytes: { type: ["integer", "null"], minimum: 0 },
  },
  additionalProperties: false,
};

const smartCollection = {
  type: "object",
  required: ["id", "name", "rules", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1, maxLength: 80 },
    rules: { type: "array", maxItems: 100, items: { $ref: "#/definitions/rule" } },
    createdAt: { $ref: "#/definitions/timestamp" },
    updatedAt: { $ref: "#/definitions/timestamp" },
  },
  additionalProperties: false,
};

const smartCollectionListItem = {
  type: "object",
  required: ["id", "name", "ruleCount", "matchCount", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1, maxLength: 80 },
    ruleCount: { type: "integer", minimum: 0, maximum: 100 },
    matchCount: { type: "integer", minimum: 0 },
    createdAt: { $ref: "#/definitions/timestamp" },
    updatedAt: { $ref: "#/definitions/timestamp" },
  },
  additionalProperties: false,
};

const steamCollectionSummary = {
  type: "object",
  required: ["id", "name", "kind", "isDynamic", "gameCount"],
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    kind: { type: "string", enum: [...STEAM_COLLECTION_KINDS] },
    isDynamic: { type: "boolean" },
    gameCount: { type: ["integer", "null"], minimum: 0 },
  },
  additionalProperties: false,
};

const errorDetail = {
  type: "object",
  required: ["code", "message"],
  properties: {
    code: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
    details: { type: "object" },
    requestId: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const sourceCounters = {
  type: "object",
  required: ["candidates", "done", "failed", "skipped"],
  properties: {
    candidates: { type: "integer", minimum: 0 },
    done: { type: "integer", minimum: 0 },
    failed: { type: "integer", minimum: 0 },
    skipped: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

const refreshRun = {
  type: "object",
  required: [
    "id",
    "scope",
    "mode",
    "status",
    "startedAt",
    "finishedAt",
    "total",
    "done",
    "appIds",
    "stats",
    "error",
  ],
  properties: {
    id: { type: "string", pattern: "^\\d+$" },
    scope: { type: "string", enum: [...REFRESH_SCOPES] },
    mode: {
      anyOf: [{ type: "string", enum: [...REFRESH_MODES] }, { type: "null" }],
    },
    status: { type: "string", enum: [...REFRESH_STATUSES] },
    startedAt: { $ref: "#/definitions/timestamp" },
    finishedAt: { $ref: "#/definitions/nullableTimestamp" },
    total: { type: ["integer", "null"], minimum: 0 },
    done: { type: "integer", minimum: 0 },
    appIds: {
      anyOf: [
        {
          type: "array",
          minItems: 1,
          items: { type: "integer", minimum: 1 },
        },
        { type: "null" },
      ],
    },
    stats: {
      anyOf: [
        {
          type: "object",
          required: ["sources"],
          properties: {
            sources: {
              type: "object",
              required: ["steamspy", "storefront", "steam_reviews"],
              properties: {
                steamspy: { $ref: "#/definitions/sourceCounters" },
                storefront: { $ref: "#/definitions/sourceCounters" },
                steam_reviews: { $ref: "#/definitions/sourceCounters" },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    error: {
      anyOf: [{ $ref: "#/definitions/errorDetail" }, { type: "null" }],
    },
  },
  additionalProperties: false,
};

const steamAccount = {
  type: "object",
  required: ["steamId64", "accountId", "personaName"],
  properties: {
    steamId64: { type: "string", pattern: "^\\d{17}$" },
    accountId: { type: "string", pattern: "^\\d+$" },
    personaName: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const sourceHealth = {
  type: "object",
  required: ["name", "status", "lastSuccessAt", "lastAttemptAt", "retryAfterAt", "lastError"],
  properties: {
    name: { type: "string", enum: [...SOURCE_ORDER] },
    status: { type: "string", enum: [...SOURCE_STATUSES] },
    lastSuccessAt: { $ref: "#/definitions/nullableTimestamp" },
    lastAttemptAt: { $ref: "#/definitions/nullableTimestamp" },
    retryAfterAt: { $ref: "#/definitions/nullableTimestamp" },
    lastError: { type: ["string", "null"] },
  },
  additionalProperties: false,
};

const tagCounters = {
  type: "object",
  required: ["ok", "missing", "stale", "error"],
  properties: {
    ok: { type: "integer", minimum: 0 },
    missing: { type: "integer", minimum: 0 },
    stale: { type: "integer", minimum: 0 },
    error: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

const metadataCounters = {
  type: "object",
  required: ["ok", "unavailable", "missing", "stale", "error"],
  properties: {
    ok: { type: "integer", minimum: 0 },
    unavailable: { type: "integer", minimum: 0 },
    missing: { type: "integer", minimum: 0 },
    stale: { type: "integer", minimum: 0 },
    error: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};

const status = {
  type: "object",
  required: [
    "app",
    "steam",
    "ownership",
    "library",
    "metadata",
    "sources",
    "activeRefresh",
    "lastRefresh",
  ],
  properties: {
    app: {
      type: "object",
      required: ["version", "dbSchemaVersion"],
      properties: {
        version: { type: "string", minLength: 1 },
        dbSchemaVersion: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    steam: {
      type: "object",
      required: ["state", "root", "ambiguous", "account"],
      properties: {
        state: { type: "string", enum: [...STEAM_STATES] },
        root: { type: ["string", "null"] },
        ambiguous: { type: "boolean" },
        account: {
          anyOf: [{ $ref: "#/definitions/steamAccount" }, { type: "null" }],
        },
      },
      additionalProperties: false,
    },
    ownership: {
      type: "object",
      required: ["state", "gameCount", "counts", "lastSuccessAt", "lastAttemptAt", "error"],
      properties: {
        state: { type: "string", enum: [...OWNERSHIP_STATES] },
        gameCount: { type: "integer", minimum: 0 },
        counts: {
          type: "object",
          required: ["owned", "localOnly", "unknown"],
          properties: {
            owned: { type: "integer", minimum: 0 },
            localOnly: { type: "integer", minimum: 0 },
            unknown: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        lastSuccessAt: { $ref: "#/definitions/nullableTimestamp" },
        lastAttemptAt: { $ref: "#/definitions/nullableTimestamp" },
        error: {
          anyOf: [{ $ref: "#/definitions/errorDetail" }, { type: "null" }],
        },
      },
      additionalProperties: false,
    },
    library: {
      type: "object",
      required: ["gameCount", "installedCount", "lastScanAt", "lastScanStatus"],
      properties: {
        gameCount: { type: "integer", minimum: 0 },
        installedCount: { type: "integer", minimum: 0 },
        lastScanAt: { $ref: "#/definitions/nullableTimestamp" },
        lastScanStatus: { type: "string", enum: [...LIBRARY_SCAN_STATUSES] },
      },
      additionalProperties: false,
    },
    metadata: {
      type: "object",
      required: ["tags", "store", "reviews", "lastSuccessAt"],
      properties: {
        tags: { $ref: "#/definitions/tagCounters" },
        store: { $ref: "#/definitions/metadataCounters" },
        reviews: { $ref: "#/definitions/metadataCounters" },
        lastSuccessAt: { $ref: "#/definitions/nullableTimestamp" },
      },
      additionalProperties: false,
    },
    sources: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: { $ref: "#/definitions/sourceHealth" },
    },
    activeRefresh: {
      anyOf: [{ $ref: "#/definitions/refreshRun" }, { type: "null" }],
    },
    lastRefresh: {
      anyOf: [{ $ref: "#/definitions/refreshRun" }, { type: "null" }],
    },
  },
  additionalProperties: false,
};

const config = {
  type: "object",
  required: [
    "dataDir",
    "steamRoot",
    "steamId64",
    "port",
    "listeningUrl",
    "openBrowser",
    "logLevel",
    "steamApiKeySet",
    "steamApiKeySource",
  ],
  properties: {
    dataDir: { type: "string", minLength: 1 },
    steamRoot: { type: ["string", "null"] },
    steamId64: { type: ["string", "null"], pattern: "^\\d{17}$" },
    port: { type: "integer", minimum: 0, maximum: 65535 },
    listeningUrl: { type: "string", minLength: 1 },
    openBrowser: { type: "boolean" },
    logLevel: { type: "string", enum: [...LOG_LEVELS] },
    steamApiKeySet: { type: "boolean" },
    steamApiKeySource: { type: "string", enum: [...STEAM_API_KEY_SOURCES] },
  },
  additionalProperties: false,
};

/** Every shape a response may reference with `#/definitions/<name>`. */
export const httpSchemaDefinitions = {
  pagination,
  singlePagePagination,
  timestamp,
  nullableTimestamp,
  gameTag,
  tagSummary,
  ruleValue,
  rule,
  gamePlatforms,
  gameMetadata,
  gameSummary,
  gameDetail,
  smartCollection,
  smartCollectionListItem,
  steamCollectionSummary,
  errorDetail,
  sourceCounters,
  refreshRun,
  steamAccount,
  sourceHealth,
  tagCounters,
  metadataCounters,
  status,
  config,
} as const;

/** Attach the shared definitions so Fastify's serialiser can resolve `$ref`s. */
function response(schema: object): object {
  return { ...schema, definitions: httpSchemaDefinitions };
}

const dataAsOfMeta = {
  type: "object",
  required: ["dataAsOf"],
  properties: { dataAsOf: { $ref: "#/definitions/nullableTimestamp" } },
  additionalProperties: false,
};

export const gamesResponseSchema = response({
  type: "object",
  required: ["data", "pagination", "meta"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/gameSummary" } },
    pagination: { $ref: "#/definitions/pagination" },
    meta: dataAsOfMeta,
  },
  additionalProperties: false,
});

export const gameDetailResponseSchema = response({
  type: "object",
  required: ["data"],
  properties: { data: { $ref: "#/definitions/gameDetail" } },
  additionalProperties: false,
});

export const tagsResponseSchema = response({
  type: "object",
  required: ["data", "pagination"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/tagSummary" } },
    pagination: { $ref: "#/definitions/pagination" },
  },
  additionalProperties: false,
});

export const ruleValuesResponseSchema = response({
  type: "object",
  required: ["data", "pagination"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/ruleValue" } },
    pagination: { $ref: "#/definitions/pagination" },
  },
  additionalProperties: false,
});

export const steamCollectionsResponseSchema = response({
  type: "object",
  required: ["data", "pagination"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/steamCollectionSummary" } },
    pagination: { $ref: "#/definitions/pagination" },
  },
  additionalProperties: false,
});

export const steamCollectionResponseSchema = response({
  type: "object",
  required: ["data"],
  properties: { data: { $ref: "#/definitions/steamCollectionSummary" } },
  additionalProperties: false,
});

export const steamCollectionGamesResponseSchema = response({
  type: "object",
  required: ["data", "pagination", "meta"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/gameSummary" } },
    pagination: { $ref: "#/definitions/pagination" },
    meta: {
      type: "object",
      required: ["dataAsOf", "dynamic"],
      properties: {
        dataAsOf: { $ref: "#/definitions/nullableTimestamp" },
        dynamic: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
});

export const smartCollectionsResponseSchema = response({
  type: "object",
  required: ["data", "pagination", "meta"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/smartCollectionListItem" } },
    pagination: { $ref: "#/definitions/pagination" },
    meta: dataAsOfMeta,
  },
  additionalProperties: false,
});

export const smartCollectionResponseSchema = response({
  type: "object",
  required: ["data"],
  properties: { data: { $ref: "#/definitions/smartCollection" } },
  additionalProperties: false,
});

export const smartCollectionGamesResponseSchema = response({
  type: "object",
  required: ["data", "pagination", "meta"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/gameSummary" } },
    pagination: { $ref: "#/definitions/pagination" },
    meta: dataAsOfMeta,
  },
  additionalProperties: false,
});

export const refreshRunResponseSchema = response({
  type: "object",
  required: ["data"],
  properties: { data: { $ref: "#/definitions/refreshRun" } },
  additionalProperties: false,
});

export const refreshStartResponseSchema = response({
  type: "object",
  required: ["data"],
  properties: {
    data: { $ref: "#/definitions/refreshRun" },
    meta: {
      type: "object",
      required: ["deduplicated"],
      properties: { deduplicated: { const: true } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
});

export const statusResponseSchema = response({
  type: "object",
  required: ["data"],
  properties: { data: { $ref: "#/definitions/status" } },
  additionalProperties: false,
});

export const configResponseSchema = response({
  type: "object",
  required: ["data"],
  properties: { data: { $ref: "#/definitions/config" } },
  additionalProperties: false,
});

export const configPatchResponseSchema = response({
  type: "object",
  required: ["data", "meta"],
  properties: {
    data: { $ref: "#/definitions/config" },
    meta: {
      type: "object",
      required: ["restartRequired"],
      properties: { restartRequired: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
});

export const steamAccountsResponseSchema = response({
  type: "object",
  required: ["data", "pagination"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/steamAccount" } },
    pagination: { $ref: "#/definitions/singlePagePagination" },
  },
  additionalProperties: false,
});

export const errorResponseSchema = response({
  type: "object",
  required: ["error"],
  properties: { error: { $ref: "#/definitions/errorDetail" } },
  additionalProperties: false,
});

/**
 * Every implemented response envelope, keyed by its contract name.
 *
 * Fastify imports these objects for response serialisation, and the contract
 * suite validates the golden fixtures against the same definitions.
 */
export const responseSchemas = {
  gamesResponse: gamesResponseSchema,
  gameDetailResponse: gameDetailResponseSchema,
  tagsResponse: tagsResponseSchema,
  ruleValuesResponse: ruleValuesResponseSchema,
  steamCollectionsResponse: steamCollectionsResponseSchema,
  steamCollectionResponse: steamCollectionResponseSchema,
  steamCollectionGamesResponse: steamCollectionGamesResponseSchema,
  smartCollectionsResponse: smartCollectionsResponseSchema,
  smartCollectionResponse: smartCollectionResponseSchema,
  smartCollectionGamesResponse: smartCollectionGamesResponseSchema,
  refreshRunResponse: refreshRunResponseSchema,
  refreshStartResponse: refreshStartResponseSchema,
  statusResponse: statusResponseSchema,
  configResponse: configResponseSchema,
  configPatchResponse: configPatchResponseSchema,
  steamAccountsResponse: steamAccountsResponseSchema,
  errorResponse: errorResponseSchema,
} as const;

export type ResponseSchemaName = keyof typeof responseSchemas;
