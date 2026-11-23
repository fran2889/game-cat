import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { describe, expect, it } from "vitest";
import {
  registerApiRoutes,
  registerConfigRoutes,
  type ApiRoutesOptions,
  type ConfigRoutes,
} from "../../src/server/http/api-routes.ts";
import {
  configPatchResponseSchema,
  configResponseSchema,
  gamesResponseSchema,
  refreshRunResponseSchema,
  refreshStartResponseSchema,
  statusResponseSchema,
  steamAccountsResponseSchema,
} from "../../src/shared/http-schemas.ts";

interface RegisteredRoute {
  method: RouteOptions["method"];
  url: string;
  schema?: { response?: Record<number, unknown> };
}

/**
 * Collect the routes as Fastify receives them. Registration only captures the
 * options, so the repositories can stay absent: no handler runs here.
 */
function registeredRoutes(register: (app: FastifyInstance) => void): RegisteredRoute[] {
  const app = Fastify({ logger: false });
  const routes: RegisteredRoute[] = [];
  app.addHook("onRoute", (route) => {
    routes.push(route as RegisteredRoute);
  });
  register(app);
  return routes;
}

function responseSchema(
  routes: RegisteredRoute[],
  method: string,
  url: string,
  statusCode: number,
): unknown {
  const route = routes.find((candidate) => candidate.method === method && candidate.url === url);
  expect(route, `${method} ${url}`).toBeDefined();
  return route?.schema?.response?.[statusCode];
}

const library = registeredRoutes((app) => registerApiRoutes(app, {} as ApiRoutesOptions));
const config = registeredRoutes((app) => registerConfigRoutes(app, {} as ConfigRoutes));

describe("Library response schemas", () => {
  it.each([
    ["GET", "/api/status", 200, statusResponseSchema],
    ["POST", "/api/rules/preview", 200, gamesResponseSchema],
    ["GET", "/api/refresh/:id", 200, refreshRunResponseSchema],
    ["POST", "/api/refresh", 202, refreshStartResponseSchema],
  ] as const)("serialises %s %s from the shared schema", (method, url, statusCode, schema) => {
    expect(responseSchema(library, method, url, statusCode)).toBe(schema);
  });
});

describe("Config response schemas", () => {
  it.each([
    ["GET", "/api/config", 200, configResponseSchema],
    ["PATCH", "/api/config", 200, configPatchResponseSchema],
    ["GET", "/api/steam/accounts", 200, steamAccountsResponseSchema],
  ] as const)("serialises %s %s from the shared schema", (method, url, statusCode, schema) => {
    expect(responseSchema(config, method, url, statusCode)).toBe(schema);
  });
});
