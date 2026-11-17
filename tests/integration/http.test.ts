import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../../src/server/http/app.ts";
import { APP_VERSION } from "../../src/shared/app.ts";
import type { Status } from "../../src/shared/types.ts";

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const status: Status = {
  app: { version: APP_VERSION, dbSchemaVersion: 0 },
  steam: { state: "not_found", root: null, ambiguous: false, account: null },
  ownership: {
    state: "not_configured",
    gameCount: 0,
    counts: { owned: 0, localOnly: 0, unknown: 0 },
    lastSuccessAt: null,
    lastAttemptAt: null,
    error: null,
  },
  library: {
    gameCount: 0,
    installedCount: 0,
    lastScanAt: null,
    lastScanStatus: "never",
  },
  metadata: {
    tags: { ok: 0, missing: 0, stale: 0, error: 0 },
    store: { ok: 0, unavailable: 0, missing: 0, stale: 0, error: 0 },
    reviews: { ok: 0, unavailable: 0, missing: 0, stale: 0, error: 0 },
    lastSuccessAt: null,
  },
  sources: [],
  activeRefresh: null,
  lastRefresh: null,
};

const clients: Array<{ app: ReturnType<typeof createHttpApp>; dir: string }> = [];

afterEach(async () => {
  while (clients.length > 0) {
    const client = clients.pop();
    await client?.app.close();
  }
});

function makeClientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-client-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
  );
  writeFileSync(join(dir, "assets", "app.js"), "console.log('game-cat');\n");
  return dir;
}

function makeApp(options: { accessLog?: PassThrough } = {}): ReturnType<typeof createHttpApp> {
  const logger = options.accessLog
    ? pino({ level: "info" }, options.accessLog)
    : pino({ level: "silent" });
  const dir = makeClientDir();
  const app = createHttpApp({ port: PORT, clientDir: dir, logger, status });
  clients.push({ app, dir });
  return app;
}

describe("GET /api/status", () => {
  it("returns 200 and the documented Status shape", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: HOST },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    const body = response.json() as { data: Status };
    expect(body.data.app.dbSchemaVersion).toBe(0);
    expect(body.data.steam.state).toBe("not_found");
    expect(body.data.library.lastScanStatus).toBe("never");
  });

  it("accepts a localhost Host header", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: `localhost:${PORT}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it("AC-A4 logs an access line with method, path, status, duration, and requestId", async () => {
    const sink = new PassThrough();
    let output = "";
    sink.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const app = makeApp({ accessLog: sink });
    const response = await app.inject({
      method: "GET",
      url: "/api/status?key=SECRET&verbose=1",
      headers: { host: HOST },
    });

    const lines = output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const access = lines.find((line) => line.msg === "request");
    expect(access).toBeDefined();
    expect(access?.method).toBe("GET");
    expect(access?.path).toBe("/api/status");
    expect(access?.status).toBe(200);
    expect(typeof access?.durationMs).toBe("number");
    expect(access?.requestId).toBe(response.headers["x-request-id"]);
    expect(output).not.toContain("SECRET");
  });
});

describe("static React shell", () => {
  it("serves the shell at / with HTML security headers", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: HOST, accept: "text/html" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain('id="root"');
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    const directives = new Map(
      String(response.headers["content-security-policy"])
        .split("; ")
        .map((directive) => {
          const [name, ...values] = directive.split(" ");
          return [name, values.join(" ")];
        }),
    );
    expect(directives.get("default-src")).toBe("'self'");
    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("style-src")).toBe("'self'");
    expect(directives.get("style-src-attr")).toBe("'unsafe-inline'");
  });

  it("falls back to the shell for extensionless client routes", async () => {
    const app = makeApp();
    for (const url of [
      "/installed",
      "/smart/abc",
      "/smart/new",
      "/steam/xyz",
      "/errors",
      "/onboarding",
      "/games/440",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { host: HOST, accept: "text/html" },
      });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toContain('id="root"');
    }
  });

  it("serves built assets without HTML headers", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/assets/app.js",
      headers: { host: HOST },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBeUndefined();
  });

  it("returns 404 for a missing static asset", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/assets/missing.js",
      headers: { host: HOST },
    });
    expect(response.statusCode).toBe(404);
  });

  it("keeps the API 404 as JSON", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/nope",
      headers: { host: HOST },
    });
    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
  });
});

describe("request trust", () => {
  it("AC-A21 rejects a foreign Host with 403 HOST_NOT_ALLOWED", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: "evil.example:4780" },
    });
    expect(response.statusCode).toBe(403);
    const body = response.json() as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("HOST_NOT_ALLOWED");
    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects a loopback host with the wrong port", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: "127.0.0.1:9999" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("AC-A21 rejects a state-changing request with a foreign Origin", async () => {
    const app = makeApp();
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: "/api/status",
        headers: {
          host: HOST,
          origin: "http://evil.example",
          "content-type": "application/json",
        },
        payload: method === "DELETE" ? undefined : "{}",
      });
      expect(response.statusCode, method).toBe(403);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        "ORIGIN_NOT_ALLOWED",
      );
    }
  });

  it("allows the server's own Origin and requests without Origin", async () => {
    const app = makeApp();
    const sameOrigin = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
      payload: "{}",
    });
    expect(sameOrigin.statusCode).toBe(404);

    const noOrigin = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: { host: HOST, "content-type": "application/json" },
      payload: "{}",
    });
    expect(noOrigin.statusCode).toBe(404);

    const safeRead = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: HOST, origin: "http://evil.example" },
    });
    expect(safeRead.statusCode).toBe(200);
  });
});

describe("request body boundary", () => {
  it("AC-A5 returns 415 for a non-JSON POST", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: { host: HOST, "content-type": "application/x-www-form-urlencoded" },
      payload: "name=value",
    });
    expect(response.statusCode).toBe(415);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "UNSUPPORTED_MEDIA_TYPE",
    );
  });

  it("AC-A5 returns 413 for a body over 256 KiB", async () => {
    const app = makeApp();
    const payload = JSON.stringify({ data: "x".repeat(300 * 1024) });
    const response = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: { host: HOST, "content-type": "application/json" },
      payload,
    });
    expect(response.statusCode).toBe(413);
    expect((response.json() as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("AC-A5 returns 400 MALFORMED_JSON for invalid JSON", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: { host: HOST, "content-type": "application/json" },
      payload: '{"oops":',
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe("MALFORMED_JSON");
  });

  it("AC-A4 uses the single error envelope with a matching requestId", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: { host: HOST, "content-type": "text/plain" },
      payload: "nope",
    });
    const body = response.json() as { error: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(body.error.message).toBeTruthy();
    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
    expect(String(response.headers["x-request-id"])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
