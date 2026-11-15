import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecretStore } from "../../src/server/config/secrets.ts";
import { createServer, type RunningServer } from "../../src/server/index.ts";
import type { OwnershipFetchResult } from "../../src/server/steam/ownership.ts";
import type { RefreshRun } from "../../src/shared/types.ts";
import { TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

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

/** A stand-in for the v4 OS-keychain store: no key ever reaches config.json. */
class MemorySecretStore implements SecretStore {
  readonly storage = "external" as const;
  value: string | null;
  readonly writes: string[] = [];

  constructor(value: string | null = null) {
    this.value = value;
  }

  read(): string | null {
    return this.value;
  }

  write(key: string): void {
    this.value = key;
    this.writes.push(key);
  }
}

class RecordingOwnershipSource {
  readonly calls: string[] = [];

  async fetchOwnedGames(steamId64: string): Promise<OwnershipFetchResult> {
    this.calls.push(steamId64);
    return { kind: "empty", gameCount: 0, games: [] };
  }
}

function baseOptions(dataDir: string, home: string) {
  return {
    dataDir,
    steamId64: TEST_STEAM_ID64,
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

async function waitFor<T>(check: () => T | null, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the condition");
}

async function patchConfig(server: RunningServer, body: unknown): Promise<Response> {
  return fetch(`${server.url}api/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("replaceable secret store", () => {
  it("AC-P10 stores the key outside config.json and never returns it", async () => {
    const dataDir = temp("game-cat-secret-store");
    const home = mkdtempSync(join(tmpdir(), "game-cat-home-"));
    const store = new MemorySecretStore();
    const server = await start({
      ...baseOptions(dataDir, home),
      secretStore: store,
    });

    const response = await patchConfig(server, { steamApiKey: "store-only-secret" });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("store-only-secret");
    const body = JSON.parse(text) as {
      data: { steamApiKeySet: boolean; steamApiKeySource: string };
    };
    expect(body.data.steamApiKeySet).toBe(true);
    expect(body.data.steamApiKeySource).toBe("file");
    expect(store.value).toBe("store-only-secret");
    expect(store.writes).toEqual(["store-only-secret"]);

    // The config file remains non-secret, and a refresh still sees the key.
    const fileText = readFileSync(join(dataDir, "config.json"), "utf8");
    expect(fileText).not.toContain("store-only-secret");
    expect(JSON.parse(fileText)).not.toHaveProperty("steamApiKey");

    const status = await fetch(`${server.url}api/config`);
    const statusText = await status.text();
    expect(statusText).not.toContain("store-only-secret");
  });

  it("AC-P10 starts Refresh with the key from the store without changing the API", async () => {
    const dataDir = temp("game-cat-secret-refresh");
    const home = mkdtempSync(join(tmpdir(), "game-cat-home-"));
    const store = new MemorySecretStore("keychain-secret");
    const ownership = new RecordingOwnershipSource();
    const server = await start({
      ...baseOptions(dataDir, home),
      secretStore: store,
      ownershipSource: ownership,
    });

    const response = await fetch(`${server.url}api/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "ownership" }),
    });
    expect(response.status).toBe(202);
    const run = ((await response.json()) as { data: RefreshRun }).data;

    await waitFor(() => ownership.calls.length > 0);
    expect(ownership.calls).toEqual([TEST_STEAM_ID64]);

    const finished = await waitFor(() => {
      const row = server.database.raw
        .prepare("SELECT status FROM refresh_runs WHERE id = ?")
        .get(Number(run.id)) as { status: string } | undefined;
      return row !== undefined && !["queued", "running"].includes(row.status) ? row : null;
    });
    expect(["succeeded", "partial"]).toContain(finished.status);

    const config = await fetch(`${server.url}api/config`);
    const configText = await config.text();
    expect(configText).not.toContain("keychain-secret");
    expect(JSON.parse(configText)).toMatchObject({
      data: { steamApiKeySet: true, steamApiKeySource: "file" },
    });
  });
});
