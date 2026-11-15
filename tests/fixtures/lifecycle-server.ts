// Spawned-process fixture for the §8.9 lifecycle tests.
//
// `mode=abortable` honours the shutdown AbortSignal so graceful cleanup can
// finish. `mode=hang` ignores it so the 5 s warning / 10 s forced-exit budget
// can be exercised with short injected budgets.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server/index.ts";
import type {
  MetadataSource,
  MetadataSourceContext,
  MetadataSourceOutcome,
} from "../../src/server/refresh/sources.ts";

const dataDir = process.argv[2];
const mode = process.argv[3] ?? "abortable";
if (dataDir === undefined) {
  throw new Error("usage: lifecycle-server <data-dir> [abortable|hang]");
}

let markStarted: () => void = () => {};
const started = new Promise<void>((resolve) => {
  markStarted = resolve;
});

const source: MetadataSource = {
  name: "steamspy",
  async fetch(context: MetadataSourceContext): Promise<MetadataSourceOutcome> {
    markStarted();
    if (mode === "hang") {
      return await new Promise<MetadataSourceOutcome>(() => {});
    }
    return await new Promise<MetadataSourceOutcome>((resolve) => {
      const finish = (): void => resolve({ kind: "error", message: "interrupted by fixture" });
      if (context.signal?.aborted === true) {
        finish();
        return;
      }
      context.signal?.addEventListener("abort", finish, { once: true });
    });
  },
};

const server = await startServer(
  {
    dataDir,
    steamId64: "76561198000000000",
    steamApiKey: "fixture-secret-key",
    steamRoot: join(mkdtempSync(join(tmpdir(), "game-cat-lifecycle-steam-")), "MissingSteam"),
    port: 0,
    openBrowser: false,
    env: {} as NodeJS.ProcessEnv,
    homedir: mkdtempSync(join(tmpdir(), "game-cat-lifecycle-home-")),
    platform: "linux",
    clientDir: null,
    logLevel: "info",
    logToStderr: true,
    startupRefresh: false,
    metadataSources: [source],
  },
  {
    warningAfterMs: Number(process.env.LIFECYCLE_WARN_MS ?? 5_000),
    forceAfterMs: Number(process.env.LIFECYCLE_FORCE_MS ?? 10_000),
  },
);

server.database.raw
  .prepare(
    `INSERT OR REPLACE INTO games (
       app_id, name, name_key, name_source, ownership_status, installed,
       playtime_minutes, source_mask, first_seen_at, last_seen_at
     ) VALUES (620, 'Fixture Game', 'fixture game', 'local', 'owned', 1, 0, 2, 1, 1)`,
  )
  .run();

const response = await fetch(`${server.url}api/refresh`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scope: "metadata", mode: "fetch" }),
});
if (response.status !== 202) {
  throw new Error(`fixture Refresh failed: ${response.status} ${await response.text()}`);
}

await started;
process.stdout.write("SOURCE_STARTED\n");
