import type { FastifyInstance } from "fastify";
import type { Status } from "../../shared/types.ts";
import { HttpError } from "../errors.ts";
import {
  parseSteamCollectionGamesQuery,
  parseSteamCollectionsQuery,
  type SteamCollectionsRepository,
} from "../library/collections.ts";
import { GamesRepository, parseGamesQuery } from "../library/games.ts";
import type { RefreshService } from "../refresh/service.ts";

export interface ApiRoutesOptions {
  status: Status | (() => Status);
  games: GamesRepository;
  collections: SteamCollectionsRepository;
  refresh: RefreshService;
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

function positiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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
    const id = positiveInteger(appId);
    if (id === null) {
      throw notFound(appId);
    }
    const game = options.games.get(id);
    if (game === null) {
      throw notFound(String(id));
    }
    return { data: game };
  });

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

  app.get("/api/refresh/:id", async (request) => {
    const { id } = request.params as { id: string };
    const parsed = positiveInteger(id);
    const run = parsed === null ? null : options.refresh.get(parsed);
    if (run === null) {
      throw notFound(id);
    }
    return { data: run };
  });

  app.post("/api/refresh", async (request, reply) => {
    const run = await options.refresh.start(request.body);
    reply.header("location", `/api/refresh/${run.id}`);
    return reply.code(202).send({ data: run });
  });
}
