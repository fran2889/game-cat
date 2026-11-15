import type { BrowserContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunningServer } from "../../src/server/index.ts";
import { createServer } from "../../src/server/index.ts";
import { SteamFixture } from "../helpers/steam-fixture.ts";

export interface TestGame {
  appId: number;
  name: string;
  installed: boolean;
  playtime: number;
  lastPlayed: number | null;
}

export interface StartAppOptions {
  games?: number;
  account?: boolean;
  empty?: boolean;
  steamMissing?: boolean;
  steamCollection?: boolean;
  /** Start without a Steam Web API key so the client routes to onboarding. */
  noKey?: boolean;
}

export interface TestApp {
  server: RunningServer;
  url: string;
  steam: SteamFixture | null;
  dataDir: string;
  game(appId: number): TestGame | undefined;
  seedDetail(appId: number): void;
  close(): Promise<void>;
}

const FIXED_GAMES: TestGame[] = [
  {
    appId: 620,
    name: "Portal 2",
    installed: true,
    playtime: 612,
    lastPlayed: 1_712_200_000,
  },
  {
    appId: 570,
    name: "Dota 2",
    installed: false,
    playtime: 0,
    lastPlayed: null,
  },
  {
    appId: 730,
    name: "Counter-Strike 2",
    installed: true,
    playtime: 1_200,
    lastPlayed: 1_712_100_000,
  },
];

function buildGames(count: number): TestGame[] {
  const games = FIXED_GAMES.slice(0, Math.min(count, FIXED_GAMES.length));
  for (let index = games.length; index < count; index += 1) {
    const number = index + 1;
    games.push({
      appId: 1_000 + number,
      name: `Fixture Game ${String(number).padStart(3, "0")}`,
      installed: number % 3 === 0,
      playtime: number % 2 === 0 ? number * 7 : 0,
      lastPlayed: number % 4 === 0 ? 1_700_000_000 + number : null,
    });
  }
  return games;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** E2E never reaches the Steam CDN or any other network host. */
export async function blockExternalRequests(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      await route.continue();
    } else {
      await route.abort();
    }
  });
}

export async function startTestApp(options: StartAppOptions = {}): Promise<TestApp> {
  const games = buildGames(options.empty === true ? 0 : (options.games ?? 130));
  const steam = new SteamFixture();
  const dataDir = tempDir("game-cat-e2e-data-");
  const home = tempDir("game-cat-e2e-home-");
  const clientDir = resolve(process.cwd(), "dist/client");
  const steamRoot = options.steamMissing === true ? join(steam.base, "MissingSteam") : steam.root;

  if (options.steamMissing !== true) {
    if (options.account !== false) {
      steam.writeLoginUsers();
    }
    steam.writeLocalConfig(
      Object.fromEntries(
        games.map((game) => [
          String(game.appId),
          {
            playtime: game.playtime,
            ...(game.lastPlayed === null ? {} : { lastPlayed: game.lastPlayed }),
          },
        ]),
      ),
    );
    for (const game of games) {
      // A manifest with StateFlags 0 keeps the name while marking the Game as
      // not installed, which mirrors a Game known locally but no longer on disk.
      steam.writeManifest(steam.root, game.appId, {
        name: game.name,
        stateFlags: game.installed ? 4 : 0,
        sizeOnDisk: game.appId === 620 ? 13_200_000_000 : 1_000_000,
        lastPlayed: game.lastPlayed,
      });
    }
    if (options.steamCollection !== false) {
      steam.writeCloudStorage([
        {
          key: "user-collections.favorite",
          value: JSON.stringify({ name: "Favorites", added: [620, 570], removed: [] }),
        },
      ]);
    }
  }

  const server = await createServer({
    dataDir,
    steamRoot,
    port: 0,
    openBrowser: false,
    ...(options.noKey === true ? {} : { steamApiKey: "e2e-steam-api-key" }),
    env: {} as NodeJS.ProcessEnv,
    homedir: home,
    platform: "linux",
    clientDir,
    logLevel: "error",
    logToStderr: false,
    startupRefresh: false,
    ownershipSource: {
      async fetchOwnedGames() {
        return { kind: "empty", gameCount: 0, games: [] };
      },
    },
  });

  if (options.account === false) {
    // The no-Account scan is deliberately partial (#23), so seed the local row
    // the Library is still expected to browse (§7.8 "No Account selected").
    server.database.raw
      .prepare(
        `INSERT OR REPLACE INTO games (
           app_id, name, name_key, name_source, ownership_status, installed,
           playtime_minutes, source_mask, first_seen_at, last_seen_at
         ) VALUES (620, 'Game 620', 'game 620', 'local', 'unknown', 1, 0, 2, 1, 1)`,
      )
      .run();
  }

  const response = await fetch(`${server.url}api/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "library" }),
  });
  if (!response.ok) {
    throw new Error(`Library scan failed: ${response.status} ${await response.text()}`);
  }

  const app: TestApp = {
    server,
    url: server.url,
    steam: options.steamMissing === true ? null : steam,
    dataDir,
    game(appId) {
      return games.find((game) => game.appId === appId);
    },
    seedDetail(appId) {
      seedDetail(server, appId);
    },
    async close() {
      await server.close();
      steam.dispose();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
  return app;
}

const FETCHED_AT = 1_700_000_100;

function seedDetail(server: RunningServer, appId: number): void {
  const db = server.database.raw;
  db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO storefront_appdetails (
         app_id, type, developers_json, publishers_json, genres_json, categories_json,
         platforms_json, release_date_raw, release_year, metacritic_score,
         store_status, store_fetched_at, updated_at
       ) VALUES (?, 'game', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      appId,
      JSON.stringify(["Valve"]),
      JSON.stringify(["Valve"]),
      JSON.stringify(["Action", "Adventure"]),
      JSON.stringify(["Single-player", "Co-op"]),
      JSON.stringify({ windows: true, mac: true, linux: false }),
      "Apr 18, 2011",
      2011,
      95,
      "ok",
      FETCHED_AT,
      FETCHED_AT,
    );
    db.prepare(
      `INSERT OR REPLACE INTO steam_review_summaries (
         app_id, review_positive, review_negative, review_total, review_tier,
         review_status, review_fetched_at, updated_at
       ) VALUES (?, 980, 20, 1000, 'Overwhelmingly Positive', 'ok', ?, ?)`,
    ).run(appId, FETCHED_AT, FETCHED_AT);
    db.prepare(
      `INSERT OR REPLACE INTO steamspy_appdetails (
         app_id, tags_status, tags_fetched_at, updated_at
       ) VALUES (?, 'ok', ?, ?)`,
    ).run(appId, FETCHED_AT, FETCHED_AT);

    for (const [index, tag] of [
      ["Puzzle", 31_415],
      ["Co-op", 21_000],
      ["Action", 9_000],
      ["Funny", 8_000],
    ].entries()) {
      const [name, votes] = tag as [string, number];
      db.prepare("INSERT OR IGNORE INTO tags (name, name_key) VALUES (?, ?)").run(
        name,
        name.toLowerCase(),
      );
      const row = db.prepare("SELECT id FROM tags WHERE name_key = ?").get(name.toLowerCase()) as {
        id: number;
      };
      db.prepare("INSERT OR REPLACE INTO game_tags (app_id, tag_id, votes) VALUES (?, ?, ?)").run(
        appId,
        row.id,
        votes + index,
      );
    }

    db.prepare("UPDATE games SET size_on_disk_bytes = ? WHERE app_id = ?").run(
      13_200_000_000,
      appId,
    );
  })();
}

/** Seed a known-zero review summary and an unavailable storefront row. */
export function seedZeroReviews(app: TestApp): void {
  const db = app.server.database.raw;
  db.prepare(
    `INSERT OR REPLACE INTO steam_review_summaries (
       app_id, review_positive, review_negative, review_total, review_tier,
       review_status, review_fetched_at, updated_at
     ) VALUES (570, 0, 0, 0, NULL, 'ok', ?, ?)`,
  ).run(FETCHED_AT, FETCHED_AT);
  db.prepare(
    `INSERT OR REPLACE INTO storefront_appdetails (
       app_id, type, developers_json, publishers_json, genres_json, categories_json,
       platforms_json, release_date_raw, release_year, metacritic_score,
       store_status, store_fetched_at, updated_at
     ) VALUES (570, 'game', '[]', '[]', '[]', '[]', '{}', NULL, NULL, NULL,
               'unavailable', ?, ?)`,
  ).run(FETCHED_AT, FETCHED_AT);
  db.prepare(
    `INSERT OR REPLACE INTO steamspy_appdetails (app_id, tags_status, updated_at)
     VALUES (570, 'missing', ?)`,
  ).run(FETCHED_AT);
}
