import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../../src/server/index.ts";
import type { GamesResponse, RefreshRun, Status } from "../../src/shared/types.ts";
import { SteamFixture, TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

const fixtures: SteamFixture[] = [];
const dirs: string[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
  while (fixtures.length > 0) {
    fixtures.pop()?.dispose();
  }
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("local scan through the real server", () => {
  it("scans the configured Steam root and serves the first Library listing", async () => {
    const steam = new SteamFixture();
    fixtures.push(steam);
    steam.writeLoginUsers();
    steam.writeManifest(steam.root, 620, { name: "Portal 2", lastPlayed: 1712100000 });
    steam.writeLocalConfig({ "620": { playtime: 612, lastPlayed: 1712200000 } });

    const server = await createServer({
      dataDir: tempDir("game-cat-scan-server-"),
      steamRoot: steam.root,
      port: 0,
      openBrowser: false,
      env: {} as NodeJS.ProcessEnv,
      homedir: tempDir("game-cat-scan-home-"),
      platform: "linux",
      clientDir: null,
      logLevel: "error",
      logToStderr: false,
    });
    servers.push(server);

    expect(server.discovery.state).toBe("ready");
    expect(server.discovery.account?.steamId64).toBe(TEST_STEAM_ID64);

    const before = (await (await fetch(`${server.url}api/status`)).json()) as { data: Status };
    expect(before.data.library.lastScanStatus).toBe("never");

    const refresh = await fetch(`${server.url}api/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "library" }),
    });
    expect(refresh.status).toBe(202);
    expect(refresh.headers.get("location")).toMatch(/^\/api\/refresh\/\d+$/);
    const started = (await refresh.json()) as { data: RefreshRun };

    let run = started;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const poll = (await (await fetch(`${server.url}api/refresh/${started.data.id}`)).json()) as {
        data: RefreshRun;
      };
      run = poll;
      if (poll.data.status !== "queued" && poll.data.status !== "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(run.data.status).toBe("succeeded");
    expect(run.data.stats).toBeNull();

    const gamesResponse = await fetch(`${server.url}api/games?pageSize=60`);
    expect(gamesResponse.status).toBe(200);
    const games = (await gamesResponse.json()) as GamesResponse;
    expect(games.data).toHaveLength(1);
    expect(games.data[0]).toMatchObject({
      appId: 620,
      name: "Portal 2",
      installed: true,
      playtimeMinutes: 612,
      lastPlayedAt: "2024-04-04T03:06:40Z",
    });

    const after = (await (await fetch(`${server.url}api/status`)).json()) as { data: Status };
    expect(after.data.library.gameCount).toBe(1);
    expect(after.data.library.installedCount).toBe(1);
    expect(after.data.library.lastScanStatus).toBe("ok");
    expect(after.data.lastRefresh?.id).toBe(run.data.id);
    expect(after.data.sources[0]?.name).toBe("steam_local");
    expect(after.data.sources[0]?.status).toBe("ok");
  });
});
