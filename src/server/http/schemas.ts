import type { FastifyRequest } from "fastify";
import {
  GAME_SORTS,
  LOG_LEVELS,
  type GameOrder,
  type GameSort,
  type RuleValueField,
} from "../../shared/types.ts";
import {
  RULE_FIELDS,
  RULE_OPERATORS,
  RULE_PREFIXES,
  RULE_VALUE_FIELDS,
} from "../../shared/rules.ts";
import { validationError } from "../request.ts";

/**
 * Fastify/AJV schemas for the HTTP boundary. The response definitions mirror
 * `tests/contract/schemas.json` exactly, so the contract suite and production
 * serialisation enforce the same shapes.
 */

const TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$";

const TAGS_STATUSES = ["ok", "missing", "stale", "error"] as const;
const METADATA_STATUSES = ["ok", "unavailable", "missing", "stale", "error"] as const;

/** An empty query value means the filter is absent; the handler maps it to null. */
const EMPTY = "";

type Empty = typeof EMPTY;

export type TagsStatus = (typeof TAGS_STATUSES)[number];
export type MetadataStatus = (typeof METADATA_STATUSES)[number];

const nullableTimestamp = {
  anyOf: [{ $ref: "#/definitions/timestamp" }, { type: "null" }],
};

/** The contract's `definitions` for every shape the Games endpoints serialise. */
export const gameContractDefinitions = {
  pagination: {
    type: "object",
    required: ["page", "pageSize", "totalItems", "totalPages"],
    properties: {
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1, maximum: 200 },
      totalItems: { type: "integer", minimum: 0 },
      totalPages: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  timestamp: {
    type: "string",
    pattern: TIMESTAMP_PATTERN,
  },
  nullableTimestamp,
  gameTag: {
    type: "object",
    required: ["name", "votes"],
    properties: {
      name: { type: "string", minLength: 1 },
      votes: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  gamePlatforms: {
    type: "object",
    properties: {
      windows: { type: "boolean" },
      mac: { type: "boolean" },
      linux: { type: "boolean" },
    },
    additionalProperties: false,
  },
  gameMetadata: {
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
  },
  gameSummary: {
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
      ownershipStatus: { type: "string", enum: ["owned", "local_only", "unknown"] },
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
  },
  gameDetail: {
    type: "object",
    required: [
      "appId",
      "name",
      "ownershipStatus",
      "installed",
      "playtimeMinutes",
      "lastPlayedAt",
      "releaseYear",
      "releaseDateRaw",
      "metacriticScore",
      "reviewScore",
      "reviewTier",
      "reviewCount",
      "type",
      "platforms",
      "developers",
      "publishers",
      "genres",
      "categories",
      "tags",
      "steamCollections",
      "sizeOnDiskBytes",
      "metadata",
    ],
    properties: {
      appId: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1 },
      ownershipStatus: { type: "string", enum: ["owned", "local_only", "unknown"] },
      installed: { type: ["boolean", "null"] },
      playtimeMinutes: { type: "integer", minimum: 0 },
      lastPlayedAt: { $ref: "#/definitions/nullableTimestamp" },
      releaseYear: { type: ["integer", "null"], minimum: 1000, maximum: 9999 },
      releaseDateRaw: { type: ["string", "null"] },
      metacriticScore: { type: ["integer", "null"], minimum: 0, maximum: 100 },
      reviewScore: { type: ["integer", "null"], minimum: 0, maximum: 100 },
      reviewTier: { type: ["string", "null"] },
      reviewCount: { type: ["integer", "null"], minimum: 0 },
      type: { type: ["string", "null"] },
      platforms: {
        anyOf: [{ $ref: "#/definitions/gamePlatforms" }, { type: "null" }],
      },
      developers: { type: "array", items: { type: "string" } },
      publishers: { type: "array", items: { type: "string" } },
      genres: { type: "array", items: { type: "string" } },
      categories: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { $ref: "#/definitions/gameTag" } },
      steamCollections: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name", "kind"],
          properties: {
            id: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            kind: {
              type: "string",
              enum: ["favorite", "hidden", "user", "tag", "system", "other"],
            },
          },
          additionalProperties: false,
        },
      },
      sizeOnDiskBytes: { type: ["integer", "null"], minimum: 0 },
      metadata: { $ref: "#/definitions/gameMetadata" },
    },
    additionalProperties: false,
  },
};

export const gamesResponseSchema = {
  type: "object",
  required: ["data", "pagination", "meta"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/gameSummary" } },
    pagination: { $ref: "#/definitions/pagination" },
    meta: {
      type: "object",
      required: ["dataAsOf"],
      properties: {
        dataAsOf: { $ref: "#/definitions/nullableTimestamp" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
  definitions: gameContractDefinitions,
};

export const gameDetailResponseSchema = {
  type: "object",
  required: ["data"],
  properties: {
    data: { $ref: "#/definitions/gameDetail" },
  },
  additionalProperties: false,
  definitions: gameContractDefinitions,
};

/** `GET /api/games/{appId}`; a non-positive or non-decimal App ID is a 404. */
export const gameIdParamsSchema = {
  type: "object",
  required: ["appId"],
  properties: {
    appId: { type: "string", pattern: "^[1-9][0-9]*$" },
  },
  additionalProperties: false,
};

function emptyIsAbsent<T>(schema: object): object {
  return { anyOf: [schema, { type: "string", enum: [EMPTY] }] };
}

/**
 * `GET /api/games` query. `sort` and `order` deliberately reject an empty
 * value; every other filter treats it as omitted, matching the documented
 * defaults and the parsers this schema replaces.
 */
export const gamesListQuerySchema = {
  type: "object",
  properties: {
    search: { type: "string", maxLength: 200 },
    sort: { type: "string", enum: [...GAME_SORTS], default: "name" },
    order: { type: "string", enum: ["asc", "desc"], default: "asc" },
    installed: emptyIsAbsent({ type: "boolean" }),
    tagsStatus: { type: "string", enum: [...TAGS_STATUSES, EMPTY] },
    storeStatus: { type: "string", enum: [...METADATA_STATUSES, EMPTY] },
    reviewStatus: { type: "string", enum: [...METADATA_STATUSES, EMPTY] },
    tagsFetched: emptyIsAbsent({ type: "boolean" }),
    storeFetched: emptyIsAbsent({ type: "boolean" }),
    reviewFetched: emptyIsAbsent({ type: "boolean" }),
    page: {
      ...emptyIsAbsent({
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
      default: 1,
    },
    pageSize: {
      ...emptyIsAbsent({ type: "integer", minimum: 1, maximum: 200 }),
      default: 60,
    },
  },
};

/** The validated shape Fastify produces for `GET /api/games`. */
export interface GamesListQuery {
  search?: string;
  sort: GameSort;
  order: GameOrder;
  installed?: boolean | Empty;
  tagsStatus?: TagsStatus | Empty;
  storeStatus?: MetadataStatus | Empty;
  reviewStatus?: MetadataStatus | Empty;
  tagsFetched?: boolean | Empty;
  storeFetched?: boolean | Empty;
  reviewFetched?: boolean | Empty;
  page: number | Empty;
  pageSize: number | Empty;
}

/**
 * Query parameters are single-valued, as every hand-written parser assumed.
 * Fastify would otherwise hand an array to AJV; reject it with the documented
 * 422 and field error before schema validation runs.
 */
export async function rejectRepeatedQueryValues(request: FastifyRequest): Promise<void> {
  if (typeof request.query !== "object" || request.query === null) {
    return;
  }
  for (const [key, value] of Object.entries(request.query)) {
    if (Array.isArray(value)) {
      throw validationError({ [key]: "must be a single value" });
    }
  }
}

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

const steamCollectionSummary = {
  type: "object",
  required: ["id", "name", "kind", "isDynamic", "gameCount"],
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ["favorite", "hidden", "user", "tag", "system", "other"] },
    isDynamic: { type: "boolean" },
    gameCount: { type: ["integer", "null"], minimum: 0 },
  },
  additionalProperties: false,
};

/** The contract definitions shared by the library read endpoints. */
export const libraryContractDefinitions = {
  ...gameContractDefinitions,
  tagSummary,
  ruleValue,
  steamCollectionSummary,
};

export const tagsResponseSchema = {
  type: "object",
  required: ["data", "pagination"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/tagSummary" } },
    pagination: { $ref: "#/definitions/pagination" },
  },
  additionalProperties: false,
  definitions: libraryContractDefinitions,
};

export const ruleValuesResponseSchema = {
  type: "object",
  required: ["data", "pagination"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/ruleValue" } },
    pagination: { $ref: "#/definitions/pagination" },
  },
  additionalProperties: false,
  definitions: libraryContractDefinitions,
};

export const steamCollectionsResponseSchema = {
  type: "object",
  required: ["data", "pagination"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/steamCollectionSummary" } },
    pagination: { $ref: "#/definitions/pagination" },
  },
  additionalProperties: false,
  definitions: libraryContractDefinitions,
};

export const steamCollectionResponseSchema = {
  type: "object",
  required: ["data"],
  properties: {
    data: { $ref: "#/definitions/steamCollectionSummary" },
  },
  additionalProperties: false,
  definitions: libraryContractDefinitions,
};

export const steamCollectionGamesResponseSchema = {
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
  definitions: libraryContractDefinitions,
};

function pageProperty(fallback: number, maximum: number): object {
  return {
    ...emptyIsAbsent({ type: "integer", minimum: 1, maximum }),
    default: fallback,
  };
}

export const tagsListQuerySchema = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 80 },
    page: pageProperty(1, Number.MAX_SAFE_INTEGER),
    pageSize: pageProperty(20, 100),
  },
};

export const ruleValuesListQuerySchema = {
  type: "object",
  required: ["field"],
  properties: {
    field: { type: "string", enum: [...RULE_VALUE_FIELDS] },
    query: { type: "string", maxLength: 80 },
    page: pageProperty(1, Number.MAX_SAFE_INTEGER),
    pageSize: pageProperty(20, 100),
  },
};

export const steamCollectionsQuerySchema = {
  type: "object",
  properties: {
    page: pageProperty(1, Number.MAX_SAFE_INTEGER),
    pageSize: pageProperty(60, 200),
  },
};

export const collectionGamesQuerySchema = {
  type: "object",
  properties: {
    page: pageProperty(1, Number.MAX_SAFE_INTEGER),
    pageSize: pageProperty(60, 200),
    sort: { type: "string", enum: [...GAME_SORTS], default: "name" },
    order: { type: "string", enum: ["asc", "desc"], default: "asc" },
  },
};

export interface PageQuery {
  page: number | Empty;
  pageSize: number | Empty;
}

export interface TagsListQuery extends PageQuery {
  query?: string;
}

export interface RuleValuesListQuery extends PageQuery {
  field: RuleValueField;
  query?: string;
}

export interface SteamCollectionGamesQuery extends PageQuery {
  sort: GameSort;
  order: GameOrder;
}

const rule = {
  type: "object",
  required: ["prefix", "field", "operator", "value"],
  properties: {
    prefix: { type: "string", enum: [...RULE_PREFIXES] },
    field: {
      type: "string",
      enum: [...RULE_FIELDS],
    },
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

export const smartCollectionContractDefinitions = {
  ...gameContractDefinitions,
  rule,
  smartCollection,
  smartCollectionListItem,
};

const dataAsOfMeta = {
  type: "object",
  required: ["dataAsOf"],
  properties: { dataAsOf: { $ref: "#/definitions/nullableTimestamp" } },
  additionalProperties: false,
};

export const smartCollectionsResponseSchema = {
  type: "object",
  required: ["data", "pagination", "meta"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/smartCollectionListItem" } },
    pagination: { $ref: "#/definitions/pagination" },
    meta: dataAsOfMeta,
  },
  additionalProperties: false,
  definitions: smartCollectionContractDefinitions,
};

export const smartCollectionResponseSchema = {
  type: "object",
  required: ["data"],
  properties: { data: { $ref: "#/definitions/smartCollection" } },
  additionalProperties: false,
  definitions: smartCollectionContractDefinitions,
};

export const smartCollectionGamesResponseSchema = {
  type: "object",
  required: ["data", "pagination", "meta"],
  properties: {
    data: { type: "array", items: { $ref: "#/definitions/gameSummary" } },
    pagination: { $ref: "#/definitions/pagination" },
    meta: dataAsOfMeta,
  },
  additionalProperties: false,
  definitions: smartCollectionContractDefinitions,
};

export const smartCollectionsListQuerySchema = {
  type: "object",
  properties: {
    page: pageProperty(1, Number.MAX_SAFE_INTEGER),
    pageSize: pageProperty(60, 200),
    sort: { type: "string", enum: ["name", "updatedAt"], default: "name" },
    order: { type: "string", enum: ["asc", "desc"], default: "asc" },
  },
};

/**
 * The envelope only: the name and rule semantics stay with the shared domain
 * validator so field errors keep their dotted paths and messages.
 */
export const smartCollectionCreateBodySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
    rules: { type: "array" },
  },
};

/** At least one of `name` or `rules`; the domain validator owns the rest. */
export const smartCollectionPatchBodySchema = {
  type: "object",
  anyOf: [{ required: ["name"] }, { required: ["rules"] }],
  properties: {
    name: { type: "string" },
    rules: { type: "array" },
  },
};

export interface SmartCollectionsListQuery extends PageQuery {
  sort: "name" | "updatedAt";
  order: GameOrder;
}

export interface SmartCollectionGamesParams extends PageQuery {
  sort: GameSort;
  order: GameOrder;
}

export interface SmartCollectionCreateBody {
  name: string;
  rules?: unknown;
}

export interface SmartCollectionPatchBody {
  name?: string;
  rules?: unknown;
}

export const configPatchBodySchema = {
  type: "object",
  properties: {
    steamApiKey: { type: "string", minLength: 1 },
    steamRoot: { type: "string", minLength: 1 },
    steamId64: { type: "string", pattern: "^\\d{17}$" },
    port: { type: "integer", minimum: 0, maximum: 65535 },
    openBrowser: { type: "boolean" },
    logLevel: { type: "string", enum: [...LOG_LEVELS] },
  },
};

export const refreshBodySchema = {
  type: "object",
  required: ["scope"],
  properties: {
    scope: { type: "string", enum: ["library", "ownership", "metadata", "all"] },
    mode: { type: "string", enum: ["fetch", "full"] },
    appIds: { type: "array", items: { type: "integer", minimum: 1 } },
  },
};

export interface ConfigPatchBody {
  steamApiKey?: string;
  steamRoot?: string;
  steamId64?: string;
  port?: number;
  openBrowser?: boolean;
  logLevel?: (typeof LOG_LEVELS)[number];
}

export type RefreshBody = {
  scope: "library" | "ownership" | "metadata" | "all";
  mode?: unknown;
  appIds?: unknown;
};
