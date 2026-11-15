import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "@playwright/test";
import { openAppDatabase } from "../../src/server/db/database.ts";
import { createServer, type RunningServer } from "../../src/server/index.ts";
import { SmartCollectionsRepository } from "../../src/server/library/smart-collections.ts";
import { readLibrary } from "../../src/server/library/rule-library.ts";
import { evaluateRuleIds } from "../../src/server/library/rule-evaluator.ts";
import { RefreshService } from "../../src/server/refresh/service.ts";
import type { MetadataSource } from "../../src/server/refresh/sources.ts";
import {
  fixtureChecksum,
  generatePerfGames,
  generatePerfSmartCollections,
  PERF_1300,
  PERF_20000,
  readRulesFixture,
  seedPerfLibrary,
  type PerfGame,
  type PerfSmartCollection,
} from "./fixtures.ts";
import { formatMilliseconds, summarize, timeAsync, timeSync, type TimingResult } from "./stats.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIENT_DIR = join(ROOT, "dist", "client");
const CLI_PATH = join(ROOT, "dist", "server", "cli.js");
const RULES_COLLECTION_ID = "00000000-0000-4000-8000-000000000100";

/**
 * The v1 performance budgets from spec §10.5. `budget` is always the p95 gate.
 * The reference runner is 4 vCPU / 8 GB RAM / local SSD / Node 24; this script
 * prints the host it actually ran on so a result is never ambiguous.
 */
interface Measurement {
  name: string;
  budgetMs: number;
  timing: TimingResult;
}

interface MeasurementSpec {
  name: string;
  budgetMs: number;
  run(): Promise<TimingResult>;
}

function requireBuild(): void {
  for (const path of [CLIENT_DIR, CLI_PATH]) {
    if (!existsSync(path)) {
      throw new Error(`Missing ${path}. Run \`npm run build\` before \`npm run test:perf\`.`);
    }
  }
}

function seedDatabase(
  dataDir: string,
  games: readonly PerfGame[],
  smartCollections: readonly PerfSmartCollection[],
  withMetadataRows = true,
): void {
  const database = openAppDatabase({ dataDir, steamWebApiConfigured: false });
  try {
    seedPerfLibrary(database.raw, { games, smartCollections, withMetadataRows });
  } finally {
    database.close();
  }
}

let steamRootCounter = 0;

async function startServer(dataDir: string, tempRoot: string, clientDir: string | null) {
  steamRootCounter += 1;
  const steamRoot = join(tempRoot, `steam-${steamRootCounter}`);
  mkdirSync(steamRoot, { recursive: true });
  return createServer({
    dataDir,
    steamRoot,
    port: 0,
    openBrowser: false,
    clientDir,
    // A configured key keeps the React shell on the Library instead of the
    // onboarding route; startup Refresh stays disabled below.
    steamApiKey: "perf-steam-api-key",
    env: {} as NodeJS.ProcessEnv,
    homedir: join(tempRoot, "home"),
    platform: "linux",
    logLevel: "error",
    logToStderr: false,
    logFilePath: null,
    startupRefresh: false,
    // Pacing must not contribute to the measured scheduler overhead.
    sleep: async () => {},
  });
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${url} -> ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

function previewRequest(rules: unknown): RequestInit {
  return {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ rules, page: 1, pageSize: 60 }),
  };
}

function patchRequest(rules: unknown): RequestInit {
  return {
    method: "PATCH",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ rules }),
  };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  await waitForExit(child);
}

/** Measure process start to the first `/api/status` 200 with an existing DB. */
async function measureStartup(dataDir: string, tempRoot: string): Promise<TimingResult> {
  const samples: number[] = [];
  const iterations = 4;
  for (let iteration = 0; iteration < iterations + 1; iteration += 1) {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/api/status`;
    const child = spawn(
      process.execPath,
      [
        CLI_PATH,
        "--data-dir",
        dataDir,
        "--port",
        String(port),
        "--no-open",
        "--log-level",
        "error",
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          GAME_CAT_STEAM_ROOT: join(tempRoot, "empty-steam-root"),
          GAME_CAT_OPEN_BROWSER: "false",
          GAME_CAT_LOG_LEVEL: "error",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const startedAt = performance.now();
    let ready = false;
    const deadline = Date.now() + 15_000;
    while (!ready && Date.now() < deadline) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (response.status === 200) {
          ready = true;
        }
      } catch {
        // Not listening yet.
      }
      if (!ready) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
    }
    const elapsed = performance.now() - startedAt;
    await stopChild(child);
    if (!ready) {
      throw new Error("Startup did not reach /api/status 200 within 15 s");
    }
    if (iteration > 0) {
      samples.push(elapsed);
    }
  }
  return summarize(samples);
}

async function measureLcp(browser: Browser, url: string, iterations = 4): Promise<TimingResult> {
  const sample = async (): Promise<number> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        const state = window as unknown as { __lcp: number | null };
        state.__lcp = null;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.__lcp = entry.startTime;
          }
        }).observe({ type: "largest-contentful-paint", buffered: true });
      });
      const statusResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/status" && response.status() === 200,
      );
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await statusResponse;
      await page.waitForFunction(
        () => document.querySelectorAll(".game-grid .game-card").length === 60,
      );
      await page.waitForFunction(() => {
        const value = (window as unknown as { __lcp: number | null }).__lcp;
        return value !== null && value !== undefined;
      });
      await page.waitForTimeout(100);
      const lcp = await page.evaluate(() => (window as unknown as { __lcp: number | null }).__lcp);
      const renderedCards = await page.locator(".game-card").count();
      const range = await page.locator(".pagination-range").innerText();
      if (renderedCards !== 60) {
        throw new Error(`A 1,300-Game Library rendered ${renderedCards} cards, expected 60`);
      }
      if (!range.includes("1–60 of 1300")) {
        throw new Error(`Unexpected pagination range for the 1,300-Game fixture: ${range}`);
      }
      if (lcp === null || lcp === undefined) {
        throw new Error("No largest-contentful-paint entry was recorded");
      }
      return lcp;
    } finally {
      await context.close();
    }
  };

  await sample();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    samples.push(await sample());
  }
  return summarize(samples);
}

function fakeMetadataSource(name: MetadataSource["name"]): MetadataSource {
  return {
    name,
    async fetch() {
      return { kind: "ok" };
    },
  };
}

function hostDescription(): string {
  return `${process.platform} ${process.arch}, Node ${process.version}, ${cpus().length} vCPU, ${Math.round(totalmem() / 1024 ** 3)} GB RAM`;
}

async function main(): Promise<void> {
  requireBuild();
  const tempRoot = mkdtempSync(join(tmpdir(), "game-cat-perf-"));
  const servers: RunningServer[] = [];
  let browser: Browser | null = null;
  try {
    const rulesFixture = readRulesFixture();
    const games20000 = generatePerfGames(PERF_20000.games, PERF_20000.seed, PERF_20000.baseAppId);
    const games1300 = generatePerfGames(PERF_1300.games, PERF_1300.seed, PERF_1300.baseAppId);
    const collections1300 = generatePerfSmartCollections(20);

    console.log("game-cat performance budgets (spec §10.5)");
    console.log(`host: ${hostDescription()}`);
    console.log(
      `reference: 4 vCPU, 8 GB RAM, local SSD, Node 24; this result is informational off that runner`,
    );
    console.log(
      `fixtures: ${PERF_20000.games.toLocaleString("en-US")} Games seed 0x${PERF_20000.seed.toString(16)} sha256 ${fixtureChecksum(games20000).slice(0, 12)}; ` +
        `${PERF_1300.games.toLocaleString("en-US")} Games seed 0x${PERF_1300.seed.toString(16)} sha256 ${fixtureChecksum(games1300).slice(0, 12)}`,
    );
    console.log(
      `rules: ${rulesFixture.rules.length} (34 AND / 33 OR / 33 NOT), Smart Collection ${RULES_COLLECTION_ID}`,
    );
    console.log("");

    const data20000 = join(tempRoot, "data-20000");
    seedDatabase(
      data20000,
      games20000,
      [
        {
          id: RULES_COLLECTION_ID,
          name: rulesFixture.name,
          rules: rulesFixture.rules,
        },
      ],
      true,
    );
    const data1300 = join(tempRoot, "data-1300");
    seedDatabase(data1300, games1300, collections1300, true);
    const dataStartup = join(tempRoot, "data-startup");
    seedDatabase(dataStartup, games1300, collections1300, true);
    const schedulerData = join(tempRoot, "data-scheduler");
    seedDatabase(schedulerData, games1300, [], false);

    const server20000 = await startServer(data20000, tempRoot, null);
    servers.push(server20000);
    const server1300 = await startServer(data1300, tempRoot, CLIENT_DIR);
    servers.push(server1300);

    const library = readLibrary(server20000.database.raw);
    const targets = [...library.targets.values()];
    if (targets.length !== PERF_20000.games) {
      throw new Error(`Expected ${PERF_20000.games} evaluator targets, got ${targets.length}`);
    }

    const specs: MeasurementSpec[] = [];

    specs.push({
      name: "Rule evaluator, 20,000 Games × 100 Rules",
      budgetMs: 500,
      run: async () =>
        timeSync(1, 10, () => {
          evaluateRuleIds(rulesFixture.rules, targets);
        }),
    });

    specs.push({
      name: "POST /api/rules/preview, 20,000 × 100",
      budgetMs: 750,
      run: async () =>
        timeAsync(1, 8, async () => {
          const body = await jsonRequest<{ pagination: { totalItems: number } }>(
            new URL("api/rules/preview", server20000.url).toString(),
            previewRequest(rulesFixture.rules),
          );
          if (body.pagination.totalItems === 0) {
            throw new Error("Preview unexpectedly matched no Games");
          }
        }),
    });

    specs.push({
      name: "GET /api/games, 1,300 Games, pageSize 60",
      budgetMs: 200,
      run: async () =>
        timeAsync(5, 30, async () => {
          const body = await jsonRequest<{ pagination: { totalItems: number } }>(
            new URL("api/games?page=1&pageSize=60", server1300.url).toString(),
          );
          if (body.pagination.totalItems !== PERF_1300.games) {
            throw new Error(`GET /api/games totalItems ${body.pagination.totalItems}`);
          }
        }),
    });

    specs.push({
      name: "GET /api/smart-collections, 20 Collections over 1,300 Games",
      budgetMs: 1_000,
      run: async () =>
        timeAsync(2, 15, async () => {
          const body = await jsonRequest<{ data: unknown[] }>(
            new URL("api/smart-collections?page=1&pageSize=60", server1300.url).toString(),
          );
          if (body.data.length !== 20) {
            throw new Error(`GET /api/smart-collections returned ${body.data.length} rows`);
          }
        }),
    });

    specs.push({
      name: "Smart Collection PATCH with 100 Rules (repository)",
      budgetMs: 300,
      run: async () =>
        timeSync(2, 20, () => {
          const repository = new SmartCollectionsRepository(server20000.database.raw, {
            now: () => 1_700_000_000,
          });
          repository.update(RULES_COLLECTION_ID, { rules: rulesFixture.rules });
        }),
    });

    specs.push({
      name: "Autosave PATCH round trip on loopback (100 Rules)",
      budgetMs: 350,
      run: async () =>
        timeAsync(2, 15, async () => {
          await jsonRequest<{ data: { rules: unknown[] } }>(
            new URL(`api/smart-collections/${RULES_COLLECTION_ID}`, server20000.url).toString(),
            patchRequest(rulesFixture.rules),
          );
        }),
    });

    specs.push({
      name: "Fetch scheduler overhead per Game/source",
      budgetMs: 5,
      run: async () => {
        const database = openAppDatabase({
          dataDir: schedulerData,
          steamWebApiConfigured: false,
        });
        try {
          const timing = await timeAsync(1, 4, async () => {
            const service = new RefreshService({
              db: database.raw,
              steamRoot: null,
              steamId64: null,
              now: () => 1_700_000_000,
              sleep: async () => {},
              sources: [
                fakeMetadataSource("steamspy"),
                fakeMetadataSource("storefront"),
                fakeMetadataSource("steam_reviews"),
              ],
            });
            await service.start({ scope: "metadata", mode: "fetch" });
            await service.waitForIdle();
          });
          const items = PERF_1300.games * 3;
          return summarize(timing.samples.map((sample) => sample / items));
        } finally {
          database.close();
        }
      },
    });

    specs.push({
      name: "Startup to /api/status 200 with an existing DB",
      budgetMs: 2_000,
      run: () => measureStartup(dataStartup, tempRoot),
    });

    browser = await chromium.launch({ headless: true });
    specs.push({
      name: "First Library page LCP after /api/status 200 (1,300 Games)",
      budgetMs: 2_500,
      run: () => measureLcp(browser!, server1300.url),
    });

    const measurements: Measurement[] = [];
    for (const spec of specs) {
      process.stdout.write(`measuring ${spec.name} ... `);
      const timing = await spec.run();
      measurements.push({ name: spec.name, budgetMs: spec.budgetMs, timing });
      console.log(`p50 ${formatMilliseconds(timing.p50)} · p95 ${formatMilliseconds(timing.p95)}`);
    }

    console.log("");
    console.log(
      [
        "Measurement".padEnd(62),
        "p50".padStart(10),
        "p95".padStart(10),
        "budget".padStart(10),
        "result",
      ].join(" "),
    );
    let failed = false;
    for (const measurement of measurements) {
      const pass = measurement.timing.p95 <= measurement.budgetMs;
      failed ||= !pass;
      console.log(
        [
          measurement.name.padEnd(62),
          formatMilliseconds(measurement.timing.p50).padStart(10),
          formatMilliseconds(measurement.timing.p95).padStart(10),
          formatMilliseconds(measurement.budgetMs).padStart(10),
          pass ? "PASS" : "FAIL",
        ].join(" "),
      );
    }
    console.log("");
    if (failed) {
      console.log("One or more performance budgets were missed.");
      process.exitCode = 1;
    } else {
      console.log("All performance budgets passed.");
    }
  } finally {
    await browser?.close().catch(() => undefined);
    for (const server of servers.reverse()) {
      await server.close().catch(() => undefined);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
