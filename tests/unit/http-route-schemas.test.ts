import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { describe, expect, it } from "vitest";
import {
  registerApiRoutes,
  registerConfigRoutes,
  registerStatusRoute,
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

interface RouteSchema {
  response?: Record<number, unknown>;
}

interface RouteCase {
  label: string;
  routes: RouteOptions[];
  method: string;
  url: string;
  statusCode: number;
  schema: unknown;
}

/**
 * Collect the routes as Fastify receives them. Registration only captures the
 * options, so the repositories can stay absent: no handler runs here.
 */
function registeredRoutes(register: (app: FastifyInstance) => void): RouteOptions[] {
  const app = Fastify({ logger: false });
  const routes: RouteOptions[] = [];
  app.addHook("onRoute", (route) => {
    routes.push(route);
  });
  register(app);
  return routes;
}

function responseSchema(
  routes: RouteOptions[],
  method: string,
  url: string,
  statusCode: number,
): unknown {
  const route = routes.find((candidate) => candidate.method === method && candidate.url === url);
  expect(route, `${method} ${url}`).toBeDefined();
  return (route?.schema as RouteSchema | undefined)?.response?.[statusCode];
}

const status = (): never => {
  throw new Error("The route registration test must not run a handler");
};

const statusRoutes = registeredRoutes((app) => registerStatusRoute(app, status));
const libraryRoutes = registeredRoutes((app) => registerApiRoutes(app, {} as ApiRoutesOptions));
const configRoutes = registeredRoutes((app) => registerConfigRoutes(app, {} as ConfigRoutes));

const cases: RouteCase[] = [
  {
    label: "status fallback",
    routes: statusRoutes,
    method: "GET",
    url: "/api/status",
    statusCode: 200,
    schema: statusResponseSchema,
  },
  {
    label: "library",
    routes: libraryRoutes,
    method: "GET",
    url: "/api/status",
    statusCode: 200,
    schema: statusResponseSchema,
  },
  {
    label: "library",
    routes: libraryRoutes,
    method: "POST",
    url: "/api/rules/preview",
    statusCode: 200,
    schema: gamesResponseSchema,
  },
  {
    label: "library",
    routes: libraryRoutes,
    method: "GET",
    url: "/api/refresh/:id",
    statusCode: 200,
    schema: refreshRunResponseSchema,
  },
  {
    label: "library",
    routes: libraryRoutes,
    method: "POST",
    url: "/api/refresh",
    statusCode: 202,
    schema: refreshStartResponseSchema,
  },
  {
    label: "config",
    routes: configRoutes,
    method: "GET",
    url: "/api/config",
    statusCode: 200,
    schema: configResponseSchema,
  },
  {
    label: "config",
    routes: configRoutes,
    method: "PATCH",
    url: "/api/config",
    statusCode: 200,
    schema: configPatchResponseSchema,
  },
  {
    label: "config",
    routes: configRoutes,
    method: "GET",
    url: "/api/steam/accounts",
    statusCode: 200,
    schema: steamAccountsResponseSchema,
  },
];

describe("response schemas", () => {
  it.each(cases)("$label serialises $method $url from the shared schema", (routeCase) => {
    expect(
      responseSchema(routeCase.routes, routeCase.method, routeCase.url, routeCase.statusCode),
    ).toBe(routeCase.schema);
  });
});
