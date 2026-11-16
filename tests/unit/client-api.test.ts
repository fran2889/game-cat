import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  deleteSmartCollection,
  fetchGames,
  fetchStatus,
  patchConfig,
  startRefresh,
} from "../../src/client/api.ts";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function recordRequests(
  respond: (request: RecordedRequest) => Response | Promise<Response>,
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? init.body : null,
    };
    requests.push(request);
    return respond(request);
  });
  return requests;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client request shape", () => {
  it("reads status with the documented accept header and unwraps data", async () => {
    const requests = recordRequests(() => json({ data: { app: { version: "1.0.0" } } }));

    await expect(fetchStatus()).resolves.toEqual({ app: { version: "1.0.0" } });
    expect(requests).toEqual([
      {
        url: "/api/status",
        method: "GET",
        headers: { accept: "application/json" },
        body: null,
      },
    ]);
  });

  it("posts a Refresh body as JSON with accept and content-type", async () => {
    const requests = recordRequests(() => json({ data: { id: 7, scope: "ownership" } }));

    await expect(startRefresh({ scope: "ownership" })).resolves.toEqual({
      id: 7,
      scope: "ownership",
    });
    expect(requests[0]).toMatchObject({
      url: "/api/refresh",
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "ownership" }),
    });
  });

  it("patches config as JSON", async () => {
    const requests = recordRequests(() => json({ data: { port: 3000 }, meta: {} }));

    await patchConfig({ port: 3000 });
    expect(requests[0]).toMatchObject({
      url: "/api/config",
      method: "PATCH",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ port: 3000 }),
    });
  });

  it("serialises every defined Game query parameter and omits undefined ones", async () => {
    const requests = recordRequests(() =>
      json({
        data: [],
        pagination: { page: 2, pageSize: 60, totalItems: 0, totalPages: 0 },
        meta: { dataAsOf: null },
      }),
    );

    await fetchGames({ page: 2, pageSize: 60, search: "portal", installed: true, sort: undefined });
    expect(requests[0]?.url).toBe("/api/games?page=2&pageSize=60&search=portal&installed=true");
  });
});

describe("API client error mapping", () => {
  it("maps an error envelope onto ApiError status, code, details, and field errors", async () => {
    recordRequests(() =>
      json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request body is invalid",
            details: { fieldErrors: { name: "must be 1-80 characters" } },
          },
        },
        422,
      ),
    );

    const error = await fetchGames().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: "ApiError",
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Request body is invalid",
      details: { fieldErrors: { name: "must be 1-80 characters" } },
    });
    expect((error as ApiError).fieldErrors).toEqual({ name: "must be 1-80 characters" });
  });

  it("keeps a status-based message when the error body is not JSON", async () => {
    recordRequests(() => new Response("upstream failure", { status: 500 }));

    const error = await fetchStatus().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 500,
      code: null,
      details: null,
      message: "Request failed with 500",
    });
  });

  it("reports 404 deletes as an ApiError so callers can treat them as already deleted", async () => {
    recordRequests(() =>
      json({ error: { code: "NOT_FOUND", message: "Smart Collection not found" } }, 404),
    );

    const error = await deleteSmartCollection("missing").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("wraps a transport failure as ApiError with a null status", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });

    const error = await fetchGames().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: null, code: null, message: "Failed to fetch" });
  });

  it("rethrows an abort so unmounted views do not report a server error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const error = await fetchGames().catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as Error).name).toBe("AbortError");
  });
});
