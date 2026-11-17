import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../../src/server/index.ts";
import type { Config, Status, SteamAccount } from "../../src/shared/types.ts";
import { SteamFixture, TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

const CLIENT_DIR = join(import.meta.dirname, "..", "fixtures", "client");

const running: RunningServer[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
});

function temp(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${randomUUID()}`);
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "game-cat-home-"));
}

function baseOptions(dataDir: string, steamRoot: string | null, home = tempHome()) {
  return {
    dataDir,
    ...(steamRoot === null ? {} : { steamRoot }),
    port: 0,
    openBrowser: false,
    env: {} as NodeJS.ProcessEnv,
    homedir: home,
    platform: "linux" as NodeJS.Platform,
    clientDir: CLIENT_DIR,
    logLevel: "error",
    logToStderr: false,
    startupRefresh: false,
  };
}

async function start(options: Parameters<typeof createServer>[0]): Promise<RunningServer> {
  const server = await createServer(options);
  running.push(server);
  return server;
}

async function getConfig(server: RunningServer): Promise<Config> {
  const response = await fetch(`${server.url}api/config`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: Config }).data;
}

interface PatchResult {
  status: number;
  body: {
    data?: Config;
    meta?: { restartRequired: boolean };
    error?: { code: string; details?: Record<string, unknown> };
  };
}

async function patchConfig(server: RunningServer, body: unknown): Promise<PatchResult> {
  const response = await fetch(`${server.url}api/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as PatchResult["body"] };
}

function configFile(dataDir: string): string {
  return readFileSync(join(dataDir, "config.json"), "utf8");
}

function tempConfigFiles(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => name.startsWith(".config.json.tmp-"));
}

describe("GET /api/config", () => {
  it("AC-A17 returns the documented shape and never the key or a prefix", async () => {
    const steam = new SteamFixture();
    steam.writeLoginUsers();
    const dataDir = temp("game-cat-config-get");
    const server = await start(baseOptions(dataDir, steam.root));

    try {
      const config = await getConfig(server);
      expect(config).toEqual({
        dataDir,
        steamRoot: steam.root,
        steamId64: TEST_STEAM_ID64,
        port: server.port,
        listeningUrl: server.url,
        openBrowser: false,
        logLevel: "error",
        steamApiKeySet: false,
        steamApiKeySource: "none",
      });
      expect(Object.hasOwn(config, "steamApiKey")).toBe(false);
    } finally {
      steam.dispose();
    }
  });

  it("reports an environment key as set/env and never returns the value", async () => {
    const dataDir = temp("game-cat-config-env");
    const server = await start({
      ...baseOptions(dataDir, null),
      env: { GAME_CAT_STEAM_API_KEY: "env-super-secret-key" } as NodeJS.ProcessEnv,
    });

    const response = await fetch(`${server.url}api/config`);
    const text = await response.text();
    const body = JSON.parse(text) as { data: Config };
    expect(body.data.steamApiKeySet).toBe(true);
    expect(body.data.steamApiKeySource).toBe("env");
    expect(text).not.toContain("env-super-secret-key");
    expect(text).not.toContain("env-super");
  });
});

describe("PATCH /api/config", () => {
  it("AC-A17 accepts a subset and reports restartRequired only when the port changes", async () => {
    const dataDir = temp("game-cat-config-patch");
    const server = await start(baseOptions(dataDir, null));
    const original = await getConfig(server);

    const browser = await patchConfig(server, { openBrowser: true });
    expect(browser.status).toBe(200);
    expect(browser.body.data?.openBrowser).toBe(true);
    expect(browser.body.meta).toEqual({ restartRequired: false });

    const port = await patchConfig(server, { port: 5123 });
    expect(port.status).toBe(200);
    expect(port.body.data?.port).toBe(5123);
    expect(port.body.meta).toEqual({ restartRequired: true });
    expect(port.body.data?.listeningUrl).toBe(original.listeningUrl);

    const samePort = await patchConfig(server, { port: 5123 });
    expect(samePort.body.meta).toEqual({ restartRequired: false });

    const logLevel = await patchConfig(server, { logLevel: "warn" });
    expect(logLevel.status).toBe(200);
    expect(logLevel.body.data?.logLevel).toBe("warn");
    expect(logLevel.body.meta).toEqual({ restartRequired: false });
    expect(server.logger.logger.level).toBe("warn");
  });

  it("AC-A17 validates each field and writes nothing on a validation error", async () => {
    const dataDir = temp("game-cat-config-invalid");
    const server = await start(baseOptions(dataDir, null));
    const before = configFile(dataDir);

    for (const [body, field] of [
      [{ port: 70000 }, "port"],
      [{ port: "5000" }, "port"],
      [{ steamId64: "123" }, "steamId64"],
      [{ steamRoot: "relative/Steam" }, "steamRoot"],
      [{ openBrowser: "yes" }, "openBrowser"],
      [{ logLevel: "loud" }, "logLevel"],
      [{ steamApiKey: "" }, "steamApiKey"],
      [{ typo: 1 }, "typo"],
    ] as const) {
      const result = await patchConfig(server, body);
      expect(result.status, JSON.stringify(body)).toBe(422);
      expect(result.body.error?.code).toBe("VALIDATION_ERROR");
      expect(
        (result.body.error?.details?.fieldErrors as Record<string, string>)[field],
        JSON.stringify(body),
      ).toBeTruthy();
    }

    expect(configFile(dataDir)).toBe(before);
  });

  it("rejects a whitespace-only Steam API key without writing it", async () => {
    const dataDir = temp("game-cat-config-blank-key");
    const server = await start(baseOptions(dataDir, null));
    const before = configFile(dataDir);

    const result = await patchConfig(server, { steamApiKey: "   " });

    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe("VALIDATION_ERROR");
    expect((result.body.error?.details?.fieldErrors as Record<string, string>).steamApiKey).toBe(
      "must be a non-empty string",
    );
    expect(configFile(dataDir)).toBe(before);
  });

  it("applies a logLevel change immediately to the log sinks", async () => {
    const dataDir = temp("game-cat-config-log-level");
    const sink = new PassThrough();
    let output = "";
    sink.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const server = await start({ ...baseOptions(dataDir, null), logSink: sink });
    server.logger.logger.debug("before-the-change");
    await patchConfig(server, { logLevel: "debug" });
    server.logger.logger.debug("after-the-change");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(output).not.toContain("before-the-change");
    expect(output).toContain("after-the-change");
  });

  it("writes the key atomically with 0600 and starts no Refresh run", async () => {
    const dataDir = temp("game-cat-config-key");
    const server = await start(baseOptions(dataDir, null));
    const result = await patchConfig(server, { steamApiKey: "super-secret-key-123" });

    expect(result.status).toBe(200);
    expect(result.body.data?.steamApiKeySet).toBe(true);
    expect(result.body.data?.steamApiKeySource).toBe("file");
    expect(result.body.meta).toEqual({ restartRequired: false });
    expect(JSON.stringify(result.body)).not.toContain("super-secret-key-123");

    if (process.platform !== "win32") {
      expect(statSync(join(dataDir, "config.json")).mode & 0o777).toBe(0o600);
    }
    expect(tempConfigFiles(dataDir)).toEqual([]);
    expect(JSON.parse(configFile(dataDir))).toEqual({ steamApiKey: "super-secret-key-123" });

    const statusResponse = await fetch(`${server.url}api/status`);
    const status = (await statusResponse.json()) as {
      data: { activeRefresh: unknown };
    };
    expect(status.data.activeRefresh).toBeNull();
  });

  it("AC-A18 rejects a key write while GAME_CAT_STEAM_API_KEY is set and writes nothing", async () => {
    const dataDir = temp("game-cat-config-env-managed");
    const server = await start({
      ...baseOptions(dataDir, null),
      env: { GAME_CAT_STEAM_API_KEY: "env-managed-key" } as NodeJS.ProcessEnv,
    });
    const before = configFile(dataDir);

    const result = await patchConfig(server, { steamApiKey: "file-key" });
    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe("VALIDATION_ERROR");
    expect(result.body.error?.details?.fieldErrors).toEqual({
      steamApiKey: "managed by GAME_CAT_STEAM_API_KEY",
    });
    expect(configFile(dataDir)).toBe(before);
    expect(tempConfigFiles(dataDir)).toEqual([]);
  });

  it("AC-A19 rejects a different bound Account and writes nothing", async () => {
    const steam = new SteamFixture();
    steam.writeLoginUsers();
    const dataDir = temp("game-cat-config-bound");
    const server = await start(baseOptions(dataDir, steam.root));
    server.database.raw
      .prepare(
        "INSERT OR REPLACE INTO account_state (singleton, steam_id64, bound_at) VALUES (1, ?, 1)",
      )
      .run("76561198000000001");
    const before = configFile(dataDir);

    try {
      const rejected = await patchConfig(server, { steamId64: "76561198000000002" });
      expect(rejected.status).toBe(409);
      expect(rejected.body.error?.code).toBe("ACCOUNT_BOUND");
      expect(rejected.body.error?.details).toEqual({
        boundSteamId64: "76561198000000001",
      });
      expect(configFile(dataDir)).toBe(before);

      const accepted = await patchConfig(server, { steamId64: "76561198000000001" });
      expect(accepted.status).toBe(200);
      expect(accepted.body.data?.steamId64).toBe("76561198000000001");
    } finally {
      steam.dispose();
    }
  });

  it("applies a saved key to the next run without starting one itself", async () => {
    const steam = new SteamFixture();
    steam.writeLoginUsers();
    const dataDir = temp("game-cat-config-run");
    let ownershipCalls = 0;
    const server = await start({
      ...baseOptions(dataDir, steam.root),
      ownershipSource: {
        async fetchOwnedGames() {
          ownershipCalls += 1;
          return { kind: "empty", gameCount: 0, games: [] };
        },
      },
    });

    try {
      const before = await fetch(`${server.url}api/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "ownership" }),
      });
      expect(before.status).toBe(409);
      expect(((await before.json()) as { error: { code: string } }).error.code).toBe(
        "OWNERSHIP_NOT_CONFIGURED",
      );

      await patchConfig(server, { steamApiKey: "next-run-key" });
      const status = (await (await fetch(`${server.url}api/status`)).json()) as {
        data: { activeRefresh: unknown };
      };
      expect(status.data.activeRefresh).toBeNull();

      const startResponse = await fetch(`${server.url}api/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "all", mode: "fetch" }),
      });
      expect(startResponse.status).toBe(202);
      const started = (await startResponse.json()) as { data: { id: string } };

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const run = (await (await fetch(`${server.url}api/refresh/${started.data.id}`)).json()) as {
          data: { status: string };
        };
        if (run.data.status !== "queued" && run.data.status !== "running") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(ownershipCalls).toBe(1);
    } finally {
      steam.dispose();
    }
  });

  it("does not write the secret to any log line", async () => {
    const dataDir = temp("game-cat-config-log");
    const sink = new PassThrough();
    let output = "";
    sink.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const server = await start({ ...baseOptions(dataDir, null), logSink: sink, logLevel: "info" });

    const key = "log-secret-key-987";
    await patchConfig(server, { steamApiKey: key });
    await fetch(`${server.url}api/config`);
    await fetch(`${server.url}api/status`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(output).not.toContain(key);
    expect(output).not.toContain("log-secret-key");
  });
});

describe("GET /api/steam/accounts", () => {
  it("AC-A20 returns data and one-page pagination and never AccountName", async () => {
    const steam = new SteamFixture();
    steam.writeLoginUsers();
    const dataDir = temp("game-cat-accounts");
    const server = await start(baseOptions(dataDir, steam.root));

    try {
      const response = await fetch(`${server.url}api/steam/accounts`);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain("AccountName");
      expect(text).not.toContain("account-under-test");
      const body = JSON.parse(text) as {
        data: SteamAccount[];
        pagination: Record<string, number>;
      };
      expect(body.data).toEqual([
        {
          steamId64: TEST_STEAM_ID64,
          accountId: "39734272",
          personaName: "Player One",
        },
      ]);
      expect(body.pagination).toEqual({
        page: 1,
        pageSize: 1,
        totalItems: 1,
        totalPages: 1,
      });
    } finally {
      steam.dispose();
    }
  });

  it("reports an ambiguous multi-Account selection in status", async () => {
    const steam = new SteamFixture();
    writeFileSync(
      join(steam.root, "config", "loginusers.vdf"),
      `"users"\n{\n` +
        `  "${TEST_STEAM_ID64}"\n  {\n    "AccountName" "first"\n    "PersonaName" "First"\n    "MostRecent" "1"\n    "Timestamp" "1663423108"\n  }\n` +
        `  "76561198000000001"\n  {\n    "AccountName" "second"\n    "PersonaName" "Second"\n    "MostRecent" "1"\n    "Timestamp" "1663423107"\n  }\n` +
        `}\n`,
    );
    const dataDir = temp("game-cat-accounts-ambiguous");
    const server = await start(baseOptions(dataDir, steam.root));

    try {
      const status = (await (await fetch(`${server.url}api/status`)).json()) as {
        data: Status;
      };
      expect(status.data.steam.state).toBe("ready");
      expect(status.data.steam.ambiguous).toBe(true);
      expect(status.data.steam.account?.steamId64).toBe(TEST_STEAM_ID64);
      const json = JSON.stringify(status);
      expect(json).not.toContain("AccountName");
      expect(json).not.toContain("first");
      expect(json).not.toContain("second");
    } finally {
      steam.dispose();
    }
  });

  it("returns one page for multiple Accounts", async () => {
    const steam = new SteamFixture();
    writeFileSync(
      join(steam.root, "config", "loginusers.vdf"),
      `"users"\n{\n` +
        `  "76561198000000000"\n  {\n    "AccountName" "first"\n    "PersonaName" "First"\n    "MostRecent" "1"\n    "Timestamp" "1663423107"\n  }\n` +
        `  "76561198000000001"\n  {\n    "AccountName" "second"\n    "PersonaName" "Second"\n    "Timestamp" "1663423108"\n  }\n` +
        `}\n`,
    );
    const dataDir = temp("game-cat-accounts-many");
    const server = await start(baseOptions(dataDir, steam.root));

    try {
      const response = await fetch(`${server.url}api/steam/accounts`);
      const body = (await response.json()) as {
        data: SteamAccount[];
        pagination: Record<string, number>;
      };
      expect(body.data).toHaveLength(2);
      expect(body.pagination).toEqual({
        page: 1,
        pageSize: 2,
        totalItems: 2,
        totalPages: 1,
      });
      expect(JSON.stringify(body)).not.toContain("first");
      expect(JSON.stringify(body)).not.toContain("second");
    } finally {
      steam.dispose();
    }
  });

  it("AC-A20 reports an empty list with pageSize 1 and totalPages 0", async () => {
    const steam = new SteamFixture();
    const dataDir = temp("game-cat-accounts-empty");
    const server = await start(baseOptions(dataDir, steam.root));

    try {
      const response = await fetch(`${server.url}api/steam/accounts`);
      const body = (await response.json()) as {
        data: SteamAccount[];
        pagination: Record<string, number>;
      };
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({
        page: 1,
        pageSize: 1,
        totalItems: 0,
        totalPages: 0,
      });
    } finally {
      steam.dispose();
    }
  });

  it("returns an empty list for a missing Steam root", async () => {
    const dataDir = temp("game-cat-accounts-missing");
    const server = await start(
      baseOptions(dataDir, join(tmpdir(), `missing-steam-${randomUUID()}`)),
    );

    const response = await fetch(`${server.url}api/steam/accounts`);
    const body = (await response.json()) as {
      data: SteamAccount[];
      pagination: Record<string, number>;
    };
    expect(body.data).toEqual([]);
    expect(body.pagination.totalItems).toBe(0);
    expect(body.pagination.pageSize).toBe(1);
    expect(body.pagination.totalPages).toBe(0);

    const status = (await (await fetch(`${server.url}api/status`)).json()) as {
      data: { steam: { state: string } };
    };
    expect(status.data.steam.state).toBe("not_found");
  });
});
