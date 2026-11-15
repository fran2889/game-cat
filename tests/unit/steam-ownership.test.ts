import { describe, expect, it } from "vitest";
import {
  createSteamOwnershipSource,
  OWNERSHIP_USER_AGENT,
  type OwnershipFetchResult,
} from "../../src/server/steam/ownership.ts";

const API_KEY = "SECRET_STEAM_WEB_API_KEY";
const STEAM_ID64 = "76561198000000000";
const EXPECTED_URL =
  "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/" +
  `?key=${API_KEY}` +
  `&steamid=${STEAM_ID64}` +
  "&include_appinfo=1" +
  "&include_played_free_games=1" +
  "&language=english" +
  "&format=json";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function source(response: Response | (() => Promise<Response>), calls: Call[] = []) {
  return createSteamOwnershipSource({
    apiKey: API_KEY,
    fetchImpl: (input, init) => {
      calls.push({ url: String(input), init });
      return typeof response === "function" ? response() : Promise.resolve(response);
    },
    now: () => 1_700_000_000,
    timeoutMs: 1_000,
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("SteamOwnershipSource", () => {
  it("AC-L16 requests GetOwnedGames with the documented URL and parameters", async () => {
    const calls: Call[] = [];
    const result = await source(
      jsonResponse({
        response: {
          game_count: 1,
          games: [{ appid: 620, name: "Portal 2", playtime_forever: 42 }],
        },
      }),
      calls,
    ).fetchOwnedGames(STEAM_ID64);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(EXPECTED_URL);
    expect(calls[0]?.init?.headers).toMatchObject({
      "user-agent": OWNERSHIP_USER_AGENT,
      accept: "application/json",
    });
    expect(result).toEqual({
      kind: "complete",
      gameCount: 1,
      games: [
        {
          appId: 620,
          name: "Portal 2",
          playtimeForeverMinutes: 42,
          playtime2WeeksMinutes: null,
        },
      ],
    });
  });

  it("classifies a complete response including played free games", async () => {
    const result = await source(
      jsonResponse({
        response: {
          game_count: 2,
          games: [
            { appid: 620, name: "Portal 2", playtime_forever: 612, playtime_2weeks: 45 },
            { appid: 570, name: "Dota 2", playtime_forever: 0 },
          ],
        },
      }),
    ).fetchOwnedGames(STEAM_ID64);

    expect(result).toMatchObject({
      kind: "complete",
      gameCount: 2,
      games: [
        { appId: 620, playtimeForeverMinutes: 612, playtime2WeeksMinutes: 45 },
        { appId: 570, playtimeForeverMinutes: 0, playtime2WeeksMinutes: null },
      ],
    });
  });

  it("classifies a short response as partial", async () => {
    const result = await source(
      jsonResponse({
        response: {
          game_count: 3,
          games: [{ appid: 620, name: "Portal 2", playtime_forever: 1 }],
        },
      }),
    ).fetchOwnedGames(STEAM_ID64);

    expect(result.kind).toBe("partial");
  });

  it("classifies zero Games and a missing games array as empty", async () => {
    const zero = await source(jsonResponse({ response: { game_count: 0 } })).fetchOwnedGames(
      STEAM_ID64,
    );
    const absent = await source(jsonResponse({ response: {} })).fetchOwnedGames(STEAM_ID64);

    expect(zero.kind).toBe("empty");
    expect(absent.kind).toBe("empty");
  });

  it("classifies 401 and 403 as invalid_key", async () => {
    for (const status of [401, 403]) {
      const result = await source(jsonResponse({}, status)).fetchOwnedGames(STEAM_ID64);
      expect(result.kind).toBe("invalid_key");
    }
  });

  it("honours Retry-After seconds and HTTP dates on 429", async () => {
    const seconds = await source(jsonResponse({}, 429, { "retry-after": "120" })).fetchOwnedGames(
      STEAM_ID64,
    );
    expect(seconds).toMatchObject({ kind: "rate_limited", retryAfterAt: 1_700_000_120 });

    const date = new Date(1_700_000_300 * 1000).toUTCString();
    const at = await source(jsonResponse({}, 429, { "retry-after": date })).fetchOwnedGames(
      STEAM_ID64,
    );
    expect(at).toMatchObject({ kind: "rate_limited", retryAfterAt: 1_700_000_300 });
  });

  it("classifies a 429 without Retry-After as rate_limited with no deadline", async () => {
    const result = await source(jsonResponse({}, 429)).fetchOwnedGames(STEAM_ID64);
    expect(result).toEqual({
      kind: "rate_limited",
      retryAfterAt: null,
      message: expect.any(String),
    });
  });

  it("classifies 5xx and network failures as error without leaking the key", async () => {
    const serverError = await source(jsonResponse({}, 503)).fetchOwnedGames(STEAM_ID64);
    expect(serverError.kind).toBe("error");

    const network: OwnershipFetchResult = await source(() =>
      Promise.reject(new Error(`connect ECONNREFUSED ${EXPECTED_URL}`)),
    ).fetchOwnedGames(STEAM_ID64);
    expect(network.kind).toBe("error");
    expect(JSON.stringify(network)).not.toContain(API_KEY);
  });

  it("classifies a timeout as error and aborts the request", async () => {
    let aborted = false;
    const result = await createSteamOwnershipSource({
      apiKey: API_KEY,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
      timeoutMs: 10,
    }).fetchOwnedGames(STEAM_ID64);

    expect(result.kind).toBe("error");
    expect(aborted).toBe(true);
  });

  it("treats an unreadable body or malformed shape as error", async () => {
    const badJson = await source(new Response("not json", { status: 200 })).fetchOwnedGames(
      STEAM_ID64,
    );
    const badShape = await source(jsonResponse({ response: { games: "nope" } })).fetchOwnedGames(
      STEAM_ID64,
    );

    expect(badJson.kind).toBe("error");
    expect(badShape.kind).toBe("error");
  });
});
