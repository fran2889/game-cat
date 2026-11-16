import type { FastifyRequest } from "fastify";
import {
  GAME_SORTS,
  type GameOrder,
  type GameSort,
  type RuleValueField,
} from "../../shared/types.ts";
import { RULE_VALUE_FIELDS } from "../library/rule-values.ts";
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

export const steamCollectionGamesQuerySchema = {
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
