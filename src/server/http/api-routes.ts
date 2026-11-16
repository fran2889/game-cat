import type { FastifyInstance } from "fastify";
import { validatePreviewRequest } from "../../shared/rules.ts";
import type {
  Config,
  ConfigPatchResponse,
  Status,
  SteamAccount,
  SteamAccountsResponse,
} from "../../shared/types.ts";
import { normalizeNameKey } from "../../shared/names.ts";
import { parseAppId } from "../app-id.ts";
import { notFound, validationError, type RawQuery } from "../request.ts";
import { type SteamCollectionsRepository } from "../library/collections.ts";
import { GamesRepository, type GamesQuery } from "../library/games.ts";
import type { RulePreviewRepository } from "../library/rule-preview.ts";
import {
  parseSmartCollectionGamesQuery,
  parseSmartCollectionsQuery,
  type SmartCollectionsRepository,
} from "../library/smart-collections.ts";
import { type RuleValuesRepository } from "../library/rule-values.ts";
import { type TagsRepository } from "../library/tags.ts";
import type { RefreshService } from "../refresh/service.ts";
import {
  gameDetailResponseSchema,
  gameIdParamsSchema,
  gamesListQuerySchema,
  gamesResponseSchema,
  rejectRepeatedQueryValues,
  ruleValuesListQuerySchema,
  ruleValuesResponseSchema,
  steamCollectionGamesQuerySchema,
  steamCollectionGamesResponseSchema,
  steamCollectionResponseSchema,
  steamCollectionsQuerySchema,
  steamCollectionsResponseSchema,
  tagsListQuerySchema,
  tagsResponseSchema,
  type GamesListQuery,
  type PageQuery,
  type RuleValuesListQuery,
  type SteamCollectionGamesQuery as SteamCollectionGamesParams,
  type TagsListQuery,
} from "./schemas.ts";

/** An empty page value takes the route's documented default. */
function pageValue(value: number | "", fallback: number): number {
  return value === "" ? fallback : value;
}

export interface ApiRoutesOptions {
  status: Status | (() => Status);
  games: GamesRepository;
  collections: SteamCollectionsRepository;
  ruleValues: RuleValuesRepository;
  rulePreview: RulePreviewRepository;
  tags: TagsRepository;
  smartCollections: SmartCollectionsRepository;
  refresh: RefreshService;
}

/** The live settings and account-picker boundary. */
export interface ConfigRoutes {
  get(): Config;
  patch(body: unknown): ConfigPatchResponse;
  accounts(): SteamAccount[];
}

export function registerConfigRoutes(app: FastifyInstance, config: ConfigRoutes): void {
  app.get("/api/config", async () => ({ data: config.get() }));

  app.patch("/api/config", async (request) => config.patch(request.body));

  app.get("/api/steam/accounts", async () => {
    const accounts = config.accounts();
    const pagination = {
      page: 1,
      pageSize: accounts.length === 0 ? 1 : accounts.length,
      totalItems: accounts.length,
      totalPages: accounts.length === 0 ? 0 : 1,
    };
    const response: SteamAccountsResponse = { data: accounts, pagination };
    return response;
  });
}

function currentStatus(status: Status | (() => Status)): Status {
  return typeof status === "function" ? status() : status;
}

function queryValues(query: unknown): RawQuery {
  if (typeof query !== "object" || query === null) {
    return {};
  }
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (value === undefined) {
      result[key] = undefined;
    } else {
      throw validationError({ [key]: "must be a single value" });
    }
  }
  return result;
}

/**
 * Map the schema-validated Games query onto the repository input. Validation
 * and bounds live in `gamesListQuerySchema`; this only resolves "empty means
 * absent" and the documented pagination defaults.
 */
function gamesQuery(query: GamesListQuery): GamesQuery {
  const boolean = (value: boolean | "" | undefined): boolean | null =>
    typeof value === "boolean" ? value : null;
  const filter = <T extends string>(value: T | "" | undefined): T | null =>
    value === undefined || value === "" ? null : value;
  return {
    search: query.search !== undefined && query.search.trim() !== "" ? query.search : null,
    sort: query.sort,
    order: query.order,
    installed: boolean(query.installed),
    tagsStatus: filter(query.tagsStatus),
    storeStatus: filter(query.storeStatus),
    reviewStatus: filter(query.reviewStatus),
    tagsFetched: boolean(query.tagsFetched),
    storeFetched: boolean(query.storeFetched),
    reviewFetched: boolean(query.reviewFetched),
    page: query.page === "" ? 1 : query.page,
    pageSize: query.pageSize === "" ? 60 : query.pageSize,
  };
}

/** The documented Library and Refresh endpoints implemented by this slice. */
export function registerApiRoutes(app: FastifyInstance, options: ApiRoutesOptions): void {
  app.get("/api/status", async () => ({ data: currentStatus(options.status) }));

  app.get<{ Querystring: GamesListQuery }>(
    "/api/games",
    {
      schema: { querystring: gamesListQuerySchema, response: { 200: gamesResponseSchema } },
      preValidation: rejectRepeatedQueryValues,
    },
    async (request) => options.games.list(gamesQuery(request.query)),
  );

  app.get<{ Params: { appId: string } }>(
    "/api/games/:appId",
    {
      schema: { params: gameIdParamsSchema, response: { 200: gameDetailResponseSchema } },
      // A malformed App ID is a 404 for this resource, not a 422 query error.
      attachValidation: true,
    },
    async (request) => {
      const { appId } = request.params;
      if (request.validationError !== undefined) {
        throw notFound(appId);
      }
      const id = parseAppId(appId);
      if (id === null) {
        throw notFound(appId);
      }
      const game = options.games.get(id);
      if (game === null) {
        throw notFound(String(id));
      }
      return { data: game };
    },
  );

  app.get<{ Querystring: RuleValuesListQuery }>(
    "/api/rule-values",
    {
      schema: {
        querystring: ruleValuesListQuerySchema,
        response: { 200: ruleValuesResponseSchema },
      },
      preValidation: rejectRepeatedQueryValues,
    },
    async (request) =>
      options.ruleValues.list({
        field: request.query.field,
        query:
          request.query.query !== undefined && request.query.query.trim() !== ""
            ? normalizeNameKey(request.query.query)
            : null,
        page: pageValue(request.query.page, 1),
        pageSize: pageValue(request.query.pageSize, 20),
      }),
  );

  app.get<{ Querystring: TagsListQuery }>(
    "/api/tags",
    {
      schema: { querystring: tagsListQuerySchema, response: { 200: tagsResponseSchema } },
      preValidation: rejectRepeatedQueryValues,
    },
    async (request) =>
      options.tags.list({
        query:
          request.query.query !== undefined && request.query.query.trim() !== ""
            ? request.query.query
            : null,
        page: pageValue(request.query.page, 1),
        pageSize: pageValue(request.query.pageSize, 20),
      }),
  );

  app.get<{ Querystring: PageQuery }>(
    "/api/steam-collections",
    {
      schema: {
        querystring: steamCollectionsQuerySchema,
        response: { 200: steamCollectionsResponseSchema },
      },
      preValidation: rejectRepeatedQueryValues,
    },
    async (request) =>
      options.collections.list({
        page: pageValue(request.query.page, 1),
        pageSize: pageValue(request.query.pageSize, 60),
      }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/steam-collections/:id",
    { schema: { response: { 200: steamCollectionResponseSchema } } },
    async (request) => {
      const { id } = request.params;
      const collection = options.collections.get(id);
      if (collection === null) {
        throw notFound(id);
      }
      return { data: collection };
    },
  );

  app.get<{ Params: { id: string }; Querystring: SteamCollectionGamesParams }>(
    "/api/steam-collections/:id/games",
    {
      schema: {
        querystring: steamCollectionGamesQuerySchema,
        response: { 200: steamCollectionGamesResponseSchema },
      },
      preValidation: rejectRepeatedQueryValues,
    },
    async (request) => {
      const { id } = request.params;
      const games = options.collections.games(id, {
        page: pageValue(request.query.page, 1),
        pageSize: pageValue(request.query.pageSize, 60),
        sort: request.query.sort,
        order: request.query.order,
      });
      if (games === null) {
        throw notFound(id);
      }
      return games;
    },
  );

  app.post("/api/rules/preview", async (request) => {
    const validated = validatePreviewRequest(request.body);
    if (Object.keys(validated.fieldErrors).length > 0) {
      throw validationError(validated.fieldErrors, "body");
    }
    return options.rulePreview.preview({
      rules: validated.rules,
      page: validated.page,
      pageSize: validated.pageSize,
      sort: validated.sort,
      order: validated.order,
    });
  });

  app.get("/api/smart-collections", async (request) =>
    options.smartCollections.list(parseSmartCollectionsQuery(queryValues(request.query))),
  );

  app.post("/api/smart-collections", async (request, reply) => {
    const collection = options.smartCollections.create(request.body);
    reply.header("location", `/api/smart-collections/${collection.id}`);
    return reply.code(201).send({ data: collection });
  });

  app.get("/api/smart-collections/:id", async (request) => {
    const { id } = request.params as { id: string };
    const collection = options.smartCollections.get(id);
    if (collection === null) {
      throw notFound(id);
    }
    return { data: collection };
  });

  app.patch("/api/smart-collections/:id", async (request) => {
    const { id } = request.params as { id: string };
    return { data: options.smartCollections.update(id, request.body) };
  });

  app.delete("/api/smart-collections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    options.smartCollections.delete(id);
    return reply.code(204).send();
  });

  app.get("/api/smart-collections/:id/games", async (request) => {
    const { id } = request.params as { id: string };
    const query = parseSmartCollectionGamesQuery(queryValues(request.query));
    const games = options.smartCollections.games(id, query);
    if (games === null) {
      throw notFound(id);
    }
    return games;
  });

  app.get("/api/refresh/:id", async (request) => {
    const { id } = request.params as { id: string };
    const parsed = parseAppId(id);
    const run = parsed === null ? null : options.refresh.get(parsed);
    if (run === null) {
      throw notFound(id);
    }
    return { data: run };
  });

  app.post("/api/refresh", async (request, reply) => {
    const result = await options.refresh.start(request.body);
    reply.header("location", `/api/refresh/${result.run.id}`);
    const body = result.deduplicated
      ? { data: result.run, meta: { deduplicated: true } }
      : { data: result.run };
    return reply.code(202).send(body);
  });
}
