import type { FastifyInstance } from "fastify";
import { validatePreviewRequest } from "../../shared/rules.ts";
import type {
  Config,
  ConfigPatchResponse,
  Status,
  SteamAccount,
  SteamAccountsResponse,
} from "../../shared/types.ts";
import { parseAppId } from "../app-id.ts";
import { HttpError } from "../errors.ts";
import {
  parseSteamCollectionGamesQuery,
  parseSteamCollectionsQuery,
  type SteamCollectionsRepository,
} from "../library/collections.ts";
import { GamesRepository, parseGamesQuery } from "../library/games.ts";
import type { RulePreviewRepository } from "../library/rule-preview.ts";
import {
  parseSmartCollectionGamesQuery,
  parseSmartCollectionsQuery,
  type SmartCollectionsRepository,
} from "../library/smart-collections.ts";
import { parseRuleValuesQuery, type RuleValuesRepository } from "../library/rule-values.ts";
import { parseTagsQuery, type TagsRepository } from "../library/tags.ts";
import type { RefreshService } from "../refresh/service.ts";

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

function queryValues(query: unknown): Record<string, string | undefined> {
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
      throw new HttpError(422, "VALIDATION_ERROR", "Request query is invalid", {
        details: { fieldErrors: { [key]: "must be a single value" } },
      });
    }
  }
  return result;
}

function notFound(identifier: string): HttpError {
  return new HttpError(404, "NOT_FOUND", "The requested resource was not found.", {
    details: { id: identifier },
  });
}

/** The documented Library and Refresh endpoints implemented by this slice. */
export function registerApiRoutes(app: FastifyInstance, options: ApiRoutesOptions): void {
  app.get("/api/status", async () => ({ data: currentStatus(options.status) }));

  app.get("/api/games", async (request) => {
    const query = parseGamesQuery(queryValues(request.query));
    return options.games.list(query);
  });

  app.get("/api/games/:appId", async (request) => {
    const { appId } = request.params as { appId: string };
    const id = parseAppId(appId);
    if (id === null) {
      throw notFound(appId);
    }
    const game = options.games.get(id);
    if (game === null) {
      throw notFound(String(id));
    }
    return { data: game };
  });

  app.get("/api/rule-values", async (request) =>
    options.ruleValues.list(parseRuleValuesQuery(queryValues(request.query))),
  );

  app.get("/api/tags", async (request) =>
    options.tags.list(parseTagsQuery(queryValues(request.query))),
  );

  app.get("/api/steam-collections", async (request) =>
    options.collections.list(parseSteamCollectionsQuery(queryValues(request.query))),
  );

  app.get("/api/steam-collections/:id", async (request) => {
    const { id } = request.params as { id: string };
    const collection = options.collections.get(id);
    if (collection === null) {
      throw notFound(id);
    }
    return { data: collection };
  });

  app.get("/api/steam-collections/:id/games", async (request) => {
    const { id } = request.params as { id: string };
    const query = parseSteamCollectionGamesQuery(queryValues(request.query));
    const games = options.collections.games(id, query);
    if (games === null) {
      throw notFound(id);
    }
    return games;
  });

  app.post("/api/rules/preview", async (request) => {
    const validated = validatePreviewRequest(request.body);
    if (Object.keys(validated.fieldErrors).length > 0) {
      throw new HttpError(422, "VALIDATION_ERROR", "Request body is invalid", {
        details: { fieldErrors: validated.fieldErrors },
      });
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
