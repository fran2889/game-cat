import type { FastifyRequest } from "fastify";
import type { ConfigPatchField } from "../../shared/config.ts";
import {
  METADATA_STATUSES,
  TAGS_STATUSES,
  type MetadataStatus,
  type TagsStatus,
} from "../../shared/http-schemas.ts";
import {
  RULE_FIELDS,
  RULE_OPERATORS,
  RULE_PREFIXES,
  RULE_VALUE_FIELDS,
} from "../../shared/rules.ts";
import {
  GAME_SORTS,
  LOG_LEVELS,
  type GameOrder,
  type GameSort,
  type RuleValueField,
} from "../../shared/types.ts";
import { validationError } from "../request.ts";

/**
 * Fastify/AJV schemas for the HTTP request boundary. Response shapes live once
 * in `src/shared/http-schemas.ts`, where both production serialisation and the
 * contract suite consume them.
 */

export type { MetadataStatus, TagsStatus };

/** An empty query value means the filter is absent; the handler maps it to null. */
const EMPTY = "";

type Empty = typeof EMPTY;

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

/** `GET /api/games/{appId}`; a non-positive or non-decimal App ID is a 404. */
export const gameIdParamsSchema = {
  type: "object",
  required: ["appId"],
  properties: {
    appId: { type: "string", pattern: "^[1-9][0-9]*$" },
  },
  additionalProperties: false,
};

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

/**
 * Reject numeric query values Fastify's AJV would coerce. The documented
 * contract is a decimal integer, and the hand-written parsers this schema
 * replaced rejected forms such as `1e3`, `+1`, and `0x10`. This runs before
 * validation, while the raw query strings are still available.
 */
export function rejectNonCanonicalIntegers(
  pageSizeMax: number,
): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    if (typeof request.query !== "object" || request.query === null) {
      return;
    }
    const query = request.query as Record<string, unknown>;
    const fieldErrors: Record<string, string> = {};
    const limits = {
      page: { min: 1, max: Number.MAX_SAFE_INTEGER },
      pageSize: { min: 1, max: pageSizeMax },
    } as const;
    for (const [key, { min, max }] of Object.entries(limits)) {
      const value = query[key];
      if (typeof value === "string" && value !== "" && !/^\d+$/.test(value)) {
        fieldErrors[key] = `must be an integer between ${min} and ${max}`;
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw validationError(fieldErrors);
    }
  };
}

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
  } satisfies Record<ConfigPatchField, object>,
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

export type RefreshBody = {
  scope: "library" | "ownership" | "metadata" | "all";
  mode?: unknown;
  appIds?: unknown;
};
