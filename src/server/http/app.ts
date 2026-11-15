import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Logger } from "pino";
import { ERROR_CODES, type ErrorDetail, type Status } from "../../shared/types.ts";
import { HttpError } from "../errors.ts";
import type { GamesRepository } from "../library/games.ts";
import type { SteamCollectionsRepository } from "../library/collections.ts";
import type { RuleValuesRepository } from "../library/rule-values.ts";
import type { TagsRepository } from "../library/tags.ts";
import { redactUrl } from "../logging/logger.ts";
import type { RefreshService } from "../refresh/service.ts";
import { registerApiRoutes } from "./api-routes.ts";

export const REQUEST_BODY_LIMIT = 256 * 1024;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://*.steamstatic.com https://*.akamaihd.net",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface CreateHttpAppOptions {
  /**
   * Actual listening port, used for Host and Origin trust checks. A getter is
   * accepted because `port: 0` is only resolved after `listen()`.
   */
  port: number | (() => number);
  /** Built client directory. `null` means no static shell is available. */
  clientDir?: string | null;
  logger: Logger;
  /** A snapshot, or a getter when Library state should be read per request. */
  status: Status | (() => Status);
  /** When present, the Game list/detail and Refresh endpoints are registered. */
  library?: {
    games: GamesRepository;
    collections: SteamCollectionsRepository;
    ruleValues: RuleValuesRepository;
    tags: TagsRepository;
    refresh: RefreshService;
  };
}

/**
 * Build the loopback HTTP boundary: request trust, error envelope, access log,
 * security headers, `/api/status`, and the static React shell with SPA fallback.
 *
 * Static serving is skipped when the client build is absent, so the API still
 * starts in a source checkout (where Vite serves the UI) or before `npm run
 * build`.
 */
export function createHttpApp(options: CreateHttpAppOptions): FastifyInstance {
  const logger = options.logger;
  const currentPort = (): number =>
    typeof options.port === "function" ? options.port() : options.port;

  // `logger: false` already suppresses Fastify's request logging; the access
  // log below is the documented one.
  const app = Fastify({
    logger: false,
    bodyLimit: REQUEST_BODY_LIMIT,
    trustProxy: false,
    genReqId: () => randomUUID(),
  });

  const clientDir =
    options.clientDir !== undefined &&
    options.clientDir !== null &&
    existsSync(join(options.clientDir, "index.html"))
      ? options.clientDir
      : null;

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const port = currentPort();
    assertTrustedRequest(
      request,
      port,
      new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
    );
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    if (request.url.startsWith("/api")) {
      reply.header("cache-control", "no-store");
    }
    const contentType = reply.getHeader("content-type");
    if (typeof contentType === "string" && contentType.includes("text/html")) {
      reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
      reply.header("x-frame-options", "DENY");
      reply.header("referrer-policy", "no-referrer");
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        path: redactUrl(request.url),
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      "request",
    );
  });

  if (options.library !== undefined) {
    registerApiRoutes(app, {
      status: options.status,
      games: options.library.games,
      collections: options.library.collections,
      ruleValues: options.library.ruleValues,
      tags: options.library.tags,
      refresh: options.library.refresh,
    });
  } else {
    app.get("/api/status", async () => ({
      data: typeof options.status === "function" ? options.status() : options.status,
    }));
  }

  if (clientDir !== null) {
    app.register(fastifyStatic, {
      root: clientDir,
      prefix: "/",
      index: ["index.html"],
      wildcard: true,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (isApiPath(request.url)) {
      return sendError(
        reply,
        request.id,
        404,
        ERROR_CODES.notFound,
        "The requested resource was not found.",
      );
    }

    if (
      clientDir !== null &&
      (request.method === "GET" || request.method === "HEAD") &&
      wantsHtml(request) &&
      !hasFileExtension(request.url)
    ) {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    }

    if (clientDir === null && wantsHtml(request)) {
      return reply
        .code(503)
        .type("text/html; charset=utf-8")
        .send(
          "<!doctype html><html><body><h1>game-cat is running</h1>" +
            "<p>The client build is missing. Run <code>npm run build</code>.</p>" +
            "</body></html>",
        );
    }

    return sendError(
      reply,
      request.id,
      404,
      ERROR_CODES.notFound,
      "The requested resource was not found.",
    );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      return sendError(
        reply,
        request.id,
        error.statusCode,
        error.code,
        error.message,
        error.details,
      );
    }

    if (isBodyTooLarge(error)) {
      return sendError(
        reply,
        request.id,
        413,
        ERROR_CODES.payloadTooLarge,
        "The request body exceeds 256 KiB.",
      );
    }

    if (isMalformedJson(error)) {
      return sendError(
        reply,
        request.id,
        400,
        ERROR_CODES.malformedJson,
        "The request body is not valid JSON.",
      );
    }

    if (error.statusCode === 415) {
      return sendError(
        reply,
        request.id,
        415,
        ERROR_CODES.unsupportedMediaType,
        "POST and PATCH bodies must be application/json.",
      );
    }

    if (error.validation !== undefined) {
      return sendError(
        reply,
        request.id,
        422,
        ERROR_CODES.validationError,
        "Request body is invalid",
        { fieldErrors: fieldErrorsFrom(error) },
      );
    }

    // Remaining client errors (for example a static handler rejecting a
    // malformed path) are reported with the single NOT_FOUND shape so the body
    // code and HTTP status never disagree.
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return sendError(
        reply,
        request.id,
        404,
        ERROR_CODES.notFound,
        "The requested resource was not found.",
      );
    }

    logger.error({ requestId: request.id, err: error }, "request failed");
    return sendError(
      reply,
      request.id,
      500,
      ERROR_CODES.internalError,
      "An unexpected error occurred.",
    );
  });

  return app;
}

function isApiPath(url: string): boolean {
  return url === "/api" || url.startsWith("/api/") || url.startsWith("/api?");
}

function hasFileExtension(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return extname(last) !== "";
}

function wantsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  if (accept === undefined) {
    return request.method === "GET" || request.method === "HEAD";
  }
  return accept.includes("text/html") || accept.includes("*/*");
}

function assertTrustedRequest(
  request: FastifyRequest,
  port: number,
  allowedOrigins: Set<string>,
): void {
  const host = request.headers.host;
  if (host === undefined || !isTrustedHost(host, port)) {
    throw new HttpError(
      403,
      ERROR_CODES.hostNotAllowed,
      "The Host header is not the local game-cat server.",
    );
  }

  const method = request.method.toUpperCase();
  if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) {
      throw new HttpError(
        403,
        ERROR_CODES.originNotAllowed,
        "The Origin header is not the local game-cat server.",
      );
    }
  }

  if (method === "POST" || method === "PATCH" || method === "PUT") {
    const contentType = request.headers["content-type"];
    if (contentType === undefined || !isJsonContentType(contentType)) {
      throw new HttpError(
        415,
        ERROR_CODES.unsupportedMediaType,
        "POST and PATCH bodies must be application/json.",
      );
    }
  }
}

function isTrustedHost(host: string, port: number): boolean {
  const match = /^(127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/i.exec(host);
  if (match === null) {
    return false;
  }
  const hostPort = match[2] === undefined ? 80 : Number.parseInt(match[2], 10);
  return hostPort === port;
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function isBodyTooLarge(error: { code?: string; statusCode?: number }): boolean {
  return error.code === "FST_ERR_CTP_BODY_TOO_LARGE" || error.statusCode === 413;
}

function isMalformedJson(error: { code?: string; statusCode?: number }): boolean {
  return (
    error.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    error.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
    (error.statusCode === 400 && error.code?.includes("JSON") === true)
  );
}

function fieldErrorsFrom(error: {
  validation?: Array<{
    instancePath?: string;
    params?: { missingProperty?: string };
    message?: string;
  }>;
}): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const item of error.validation ?? []) {
    const key =
      item.instancePath !== undefined && item.instancePath !== ""
        ? item.instancePath.replace(/^\//, "").replaceAll("/", ".")
        : (item.params?.missingProperty ?? "body");
    fieldErrors[key] = item.message ?? "is invalid";
  }
  return fieldErrors;
}

function sendError(
  reply: FastifyReply,
  requestId: string,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  const error: ErrorDetail = { code, message, requestId };
  if (details !== undefined) {
    error.details = details;
  }
  reply.header("x-request-id", requestId);
  return reply.code(statusCode).send({ error });
}
