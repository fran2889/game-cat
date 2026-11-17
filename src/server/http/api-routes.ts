import type { FastifyInstance, FastifyRequest } from "fastify";
import { validatePreviewRequest, validateRules, type Rule } from "../../shared/rules.ts";
import type {
  Config,
  ConfigPatchResponse,
  Status,
  SteamAccount,
  SteamAccountsResponse,
} from "../../shared/types.ts";
import type { ConfigPatch } from "../../shared/config.ts";
import { normalizeNameKey } from "../../shared/names.ts";
import { parseAppId } from "../app-id.ts";
import { notFound, validationError } from "../request.ts";
import { type SteamCollectionsRepository } from "../library/collections.ts";
import { GamesRepository, type GamesQuery } from "../library/games.ts";
import type { RulePreviewRepository } from "../library/rule-preview.ts";
import {
  type SmartCollectionsRepository,
  validateSmartCollectionName,
} from "../library/smart-collections.ts";
import { type RuleValuesRepository } from "../library/rule-values.ts";
import { type TagsRepository } from "../library/tags.ts";
import type { RefreshService } from "../refresh/service.ts";
import {
  configPatchBodySchema,
  gameDetailResponseSchema,
  gameIdParamsSchema,
  gamesListQuerySchema,
  gamesResponseSchema,
  refreshBodySchema,
  rejectRepeatedQueryValues,
  ruleValuesListQuerySchema,
  ruleValuesResponseSchema,
  collectionGamesQuerySchema,
  steamCollectionGamesResponseSchema,
  steamCollectionResponseSchema,
  smartCollectionCreateBodySchema,
  smartCollectionGamesResponseSchema,
  smartCollectionPatchBodySchema,
  smartCollectionResponseSchema,
  smartCollectionsListQuerySchema,
  smartCollectionsResponseSchema,
  steamCollectionsQuerySchema,
  steamCollectionsResponseSchema,
  tagsListQuerySchema,
  tagsResponseSchema,
  type GamesListQuery,
  type PageQuery,
  type RefreshBody,
  type RuleValuesListQuery,
  type SmartCollectionCreateBody,
  type SmartCollectionGamesParams,
  type SmartCollectionPatchBody,
  type SmartCollectionsListQuery,
  type SteamCollectionGamesQuery as SteamCollectionGamesParams,
  type TagsListQuery,
} from "./schemas.ts";

/** An empty page value takes the route's documented default. */
function pageValue(value: number | "", fallback: number): number {
  return value === "" ? fallback : value;
}

/**
 * Config values arrive typed from JSON; Fastify would otherwise coerce a
 * string port or a string flag into a valid-looking value. Check the parsed
 * body before validation so the documented 422s survive.
 */
async function rejectCoercedConfigFields(request: FastifyRequest): Promise<void> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return;
  }
  const record = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};
  for (const field of ["steamApiKey", "steamRoot", "steamId64", "logLevel"]) {
    if (field in record && typeof record[field] !== "string") {
      fieldErrors[field] = "must be a string";
    }
  }
  if ("port" in record && (typeof record.port !== "number" || !Number.isInteger(record.port))) {
    fieldErrors.port = "must be an integer between 0 and 65535";
  }
  if ("openBrowser" in record && typeof record.openBrowser !== "boolean") {
    fieldErrors.openBrowser = "must be a boolean";
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw validationError(fieldErrors, "body");
  }
}

/** The Refresh envelope types, checked before ajv can coerce them. */
async function rejectCoercedRefreshFields(request: FastifyRequest): Promise<void> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return;
  }
  const record = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};
  if ("scope" in record && typeof record.scope !== "string") {
    fieldErrors.scope = "must be a string";
  }
  if ("mode" in record && typeof record.mode !== "string") {
    fieldErrors.mode = "must be a string";
  }
  if ("appIds" in record) {
    const appIds = record.appIds;
    if (!Array.isArray(appIds)) {
      fieldErrors.appIds = "must be an array of App IDs";
    } else if (
      appIds.some(
        (entry) => typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0,
      )
    ) {
      fieldErrors.appIds = "must be positive integers";
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw validationError(fieldErrors, "body");
  }
}

/** Rule semantics stay with the shared validator; this only collects its errors. */
function validatedRules(value: unknown, fieldErrors: Record<string, string>): Rule[] {
  const validated = validateRules(value);
  Object.assign(fieldErrors, validated.fieldErrors);
  return validated.rules;
}

/**
 * Fastify's ajv coerces body scalars (`42` becomes `"42"`, `null` becomes
 * `[null]`), which would accept bodies the hand-written validators rejected.
 * This runs before validation, while the parsed body still has its real types.
 */
async function rejectCoercedBodyFields(request: FastifyRequest): Promise<void> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return;
  }
  const record = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};
  if ("name" in record && typeof record.name !== "string") {
    fieldErrors.name = "must be a string";
  }
  if ("rules" in record && !Array.isArray(record.rules)) {
    fieldErrors.rules = "must be an array";
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw validationError(fieldErrors, "body");
  }
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

  app.patch<{ Body: ConfigPatch }>(
    "/api/config",
    { schema: { body: configPatchBodySchema }, preValidation: rejectCoercedConfigFields },
    async (request) => config.patch(request.body),
  );

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
        querystring: collectionGamesQuerySchema,
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

  app.get<{ Querystring: SmartCollectionsListQuery }>(
    "/api/smart-collections",
    {
      schema: {
        querystring: smartCollectionsListQuerySchema,
        response: { 200: smartCollectionsResponseSchema },
      },
      preValidation: rejectRepeatedQueryValues,
    },
    async (request) =>
      options.smartCollections.list({
        page: pageValue(request.query.page, 1),
        pageSize: pageValue(request.query.pageSize, 60),
        sort: request.query.sort,
        order: request.query.order,
      }),
  );

  app.post<{ Body: SmartCollectionCreateBody }>(
    "/api/smart-collections",
    {
      schema: {
        body: smartCollectionCreateBodySchema,
        response: { 201: smartCollectionResponseSchema },
      },
      preValidation: rejectCoercedBodyFields,
    },
    async (request, reply) => {
      const fieldErrors: Record<string, string> = {};
      const name = validateSmartCollectionName(request.body.name, fieldErrors) ?? "";
      const rules = validatedRules(request.body.rules, fieldErrors);
      if (Object.keys(fieldErrors).length > 0) {
        throw validationError(fieldErrors, "body");
      }
      const collection = options.smartCollections.create({ name, rules });
      reply.header("location", `/api/smart-collections/${collection.id}`);
      return reply.code(201).send({ data: collection });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/smart-collections/:id",
    { schema: { response: { 200: smartCollectionResponseSchema } } },
    async (request) => {
      const { id } = request.params;
      const collection = options.smartCollections.get(id);
      if (collection === null) {
        throw notFound(id);
      }
      return { data: collection };
    },
  );

  app.patch<{ Params: { id: string }; Body: SmartCollectionPatchBody }>(
    "/api/smart-collections/:id",
    {
      schema: {
        body: smartCollectionPatchBodySchema,
        response: { 200: smartCollectionResponseSchema },
      },
      preValidation: rejectCoercedBodyFields,
    },
    async (request) => {
      const { id } = request.params;
      const fieldErrors: Record<string, string> = {};
      const name =
        request.body.name === undefined
          ? undefined
          : (validateSmartCollectionName(request.body.name, fieldErrors) ?? undefined);
      const rules =
        request.body.rules === undefined
          ? undefined
          : validatedRules(request.body.rules, fieldErrors);
      if (Object.keys(fieldErrors).length > 0) {
        throw validationError(fieldErrors, "body");
      }
      return { data: options.smartCollections.update(id, { name, rules }) };
    },
  );

  app.delete("/api/smart-collections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    options.smartCollections.delete(id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: SmartCollectionGamesParams }>(
    "/api/smart-collections/:id/games",
    {
      schema: {
        querystring: collectionGamesQuerySchema,
        response: { 200: smartCollectionGamesResponseSchema },
      },
      preValidation: rejectRepeatedQueryValues,
    },
    async (request) => {
      const { id } = request.params;
      const games = options.smartCollections.games(id, {
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

  app.get("/api/refresh/:id", async (request) => {
    const { id } = request.params as { id: string };
    const parsed = parseAppId(id);
    const run = parsed === null ? null : options.refresh.get(parsed);
    if (run === null) {
      throw notFound(id);
    }
    return { data: run };
  });

  app.post<{ Body: RefreshBody }>(
    "/api/refresh",
    { schema: { body: refreshBodySchema }, preValidation: rejectCoercedRefreshFields },
    async (request, reply) => {
      const result = await options.refresh.start(request.body);
      reply.header("location", `/api/refresh/${result.run.id}`);
      const body = result.deduplicated
        ? { data: result.run, meta: { deduplicated: true } }
        : { data: result.run };
      return reply.code(202).send(body);
    },
  );
}
