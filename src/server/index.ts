import { homedir as osHomedir } from "node:os";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { APP_VERSION, MIN_NODE_MAJOR } from "../shared/app.ts";
import type { Config, LogLevel, Status } from "../shared/types.ts";
import { loadConfig, type ConfigOverrides, type ResolvedConfig } from "./config/load.ts";
import { assertDataDirOutsideSteam, prepareDataDir } from "./config/data-dir.ts";
import type { SecretStore } from "./config/secrets.ts";
import { ConfigStore } from "./config/store.ts";
import {
  openAppDatabase,
  readBoundSteamId64,
  type AppDatabase,
  type OpenDatabase,
} from "./db/database.ts";
import { isStartupError, StartupError } from "./errors.ts";
import { createHttpApp } from "./http/app.ts";
import { GamesRepository } from "./library/games.ts";
import { SteamCollectionsRepository } from "./library/collections.ts";
import { RulePreviewRepository } from "./library/rule-preview.ts";
import { RuleValuesRepository } from "./library/rule-values.ts";
import { SmartCollectionsRepository } from "./library/smart-collections.ts";
import { TagsRepository } from "./library/tags.ts";
import { createLogger, defaultLogPath, type AppLogger } from "./logging/logger.ts";
import { acquireLock, type LockHandle } from "./lock.ts";
import { openBrowserBestEffort } from "./open-browser.ts";
import { RefreshService } from "./refresh/service.ts";
import { SteamReviewSource } from "./refresh/reviews.ts";
import type { MetadataSource } from "./refresh/sources.ts";
import { assertNodeVersion } from "./node-version.ts";
import { discoverSteam, type SteamDiscovery, type SteamDiscoveryFn } from "./steam/discovery.ts";
import type { SteamOwnershipSource } from "./steam/ownership.ts";
import { createSteamSpySource } from "./steam/steamspy.ts";
import { StorefrontSource } from "./steam/storefront.ts";
import { buildStatus } from "./status.ts";

export interface ServerOptions {
  dataDir?: string;
  steamApiKey?: string;
  steamRoot?: string;
  steamId64?: string;
  port?: number | string;
  openBrowser?: boolean;
  logLevel?: string;

  /** Environment and platform seams (default: the real process). */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homedir?: string;
  platform?: NodeJS.Platform;
  /** Test seam for the runtime floor; never a supported way to bypass it. */
  nodeVersion?: string;

  /** Built client directory. `null` disables static serving. */
  clientDir?: string | null;
  /** Additional log sink; the v4 wrapper can capture this stream. */
  logSink?: Writable;
  logToStderr?: boolean;
  tty?: boolean;
  /** `null` disables the log file. Default `<data-dir>/logs/game-cat.log`. */
  logFilePath?: string | null;
  maxLogFileSizeBytes?: number;
  logKeepFiles?: number;
  /** Test seam and the future local-scan boundary (#23). */
  steamDiscovery?: SteamDiscoveryFn;
  /** Injectable ownership adapter; tests use a fake and production builds one from the key. */
  ownershipSource?: SteamOwnershipSource;
  /** Injectable database boundary. Defaults to the bundled migration runner. */
  database?: OpenDatabase;
  /**
   * Metadata adapter registration point (#28-#30) and a no-network test seam.
   * The production list registers the implemented adapters; tests inject fakes.
   */
  metadataSources?: readonly MetadataSource[];
  /**
   * Test seam: pacing/backoff sleep. Tests inject a fake clock that advances
   * time without waiting; production uses real timers.
   */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam: monotonic milliseconds paired with `sleep` for pacing. */
  nowMs?: () => number;
  /** Test seam: skip the documented startup `all` + Fetch trigger. Recovery of
   * interrupted runs still happens.
   */
  startupRefresh?: boolean;
  /**
   * Replaceable Steam Web API key storage (§8.10 item 8). Defaults to the
   * `steamApiKey` field in `<data-dir>/config.json`.
   */
  secretStore?: SecretStore;
}

export interface RunningServer {
  app: FastifyInstance;
  logger: AppLogger;
  config: Config;
  discovery: SteamDiscovery;
  database: AppDatabase;
  port: number;
  url: string;
  close(): Promise<void>;
}

const SIGNALS: readonly NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Programmatic startup seam required by §8.10. Resolves only after the socket
 * is listening; `close()` stops accepting, releases the lock, and closes the log
 * file. The CLI and the v4 wrapper both build on this function.
 */
export async function createServer(options: ServerOptions = {}): Promise<RunningServer> {
  assertNodeVersion(options.nodeVersion ?? process.versions.node);
  if (process.platform !== "win32") {
    // Set before creating the data directory and its files (§8.3).
    process.umask(0o077);
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? osHomedir();
  const overrides: ConfigOverrides = {
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.steamApiKey === undefined ? {} : { steamApiKey: options.steamApiKey }),
    ...(options.steamRoot === undefined ? {} : { steamRoot: options.steamRoot }),
    ...(options.steamId64 === undefined ? {} : { steamId64: options.steamId64 }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser }),
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
  };

  const resolved = loadConfig({
    overrides,
    env,
    platform,
    homedir: home,
    cwd: options.cwd,
  });

  // Resolve the key before the database opens, with the same precedence the
  // ConfigStore uses. An external store never requires 0600 on config.json.
  const environmentKey = resolved.steamApiKeySource === "env" ? resolved.steamApiKey : null;
  const programmaticKey =
    resolved.steamApiKeySource !== "env" &&
    resolved.steamApiKey !== null &&
    resolved.steamApiKey !== resolved.fileConfig.steamApiKey;
  const initialApiKey =
    environmentKey !== null
      ? environmentKey
      : programmaticKey
        ? resolved.steamApiKey
        : options.secretStore === undefined
          ? resolved.steamApiKey
          : options.secretStore.read();
  const keySource: "file" | "env" | "none" =
    options.secretStore !== undefined && options.secretStore.storage === "external"
      ? environmentKey === null
        ? "none"
        : "env"
      : resolved.steamApiKeySource;

  const discovery = (options.steamDiscovery ?? discoverSteam)({
    steamRoot: resolved.steamRoot,
    steamId64: resolved.steamId64,
    platform,
    env,
    homedir: home,
  });

  assertDataDirOutsideSteam(resolved.dataDir, resolved.steamRoot ?? discovery.root);

  const prepared = prepareDataDir({
    dataDir: resolved.dataDir,
    configPath: resolved.configPath,
    configFileExists: resolved.configFileExists,
    keySource,
    platform,
  });

  const lockPath = join(resolved.dataDir, "game-cat.lock");
  const logFileTarget =
    options.logFilePath === undefined ? defaultLogPath(resolved.dataDir) : options.logFilePath;

  let lock: LockHandle | null = null;
  let appLogger: AppLogger | null = null;
  let app: FastifyInstance | null = null;
  let database: AppDatabase | null = null;

  try {
    // The lock is taken before any database work. #22 opens SQLite after this.
    lock = acquireLock({ lockPath, dataDir: resolved.dataDir });

    appLogger = createLogger({
      level: resolved.logLevel,
      filePath: logFileTarget,
      stderr: options.logToStderr ?? true,
      stream: options.logSink,
      tty: options.tty,
      maxFileSizeBytes: options.maxLogFileSizeBytes,
      keepFiles: options.logKeepFiles,
    });
    const logger = appLogger.logger;

    if (appLogger.fileError !== null) {
      logger.warn(
        { logFile: logFileTarget, err: appLogger.fileError },
        "log file unavailable; continuing on stderr",
      );
    }
    for (const warning of [...resolved.warnings, ...prepared.warnings]) {
      logger.warn({ warning }, "startup warning");
    }

    // §8.5 step 7: open SQLite only after the single-instance lock. The
    // account guard (§8.5 step 8) runs inside the opener.
    const selectedSteamId64 = discovery.account?.steamId64 ?? resolved.steamId64;
    const openDatabase = options.database ?? openAppDatabase;
    database = openDatabase({
      dataDir: resolved.dataDir,
      steamWebApiConfigured: initialApiKey !== null && selectedSteamId64 !== null,
      selectedSteamId64,
    });

    let refreshService: RefreshService | null = null;
    const configStore = new ConfigStore({
      resolved,
      discovery,
      port: resolved.port,
      listeningUrl: `http://127.0.0.1:${resolved.port}/`,
      platform,
      env,
      homedir: home,
      setLogLevel: (level) => {
        logger.level = level;
      },
      boundSteamId64: () => (database === null ? null : readBoundSteamId64(database.raw)),
      ...(options.secretStore === undefined ? {} : { secretStore: options.secretStore }),
      onChange: (config, restartRequired) => {
        refreshService?.applyConfig({
          steamRoot: config.steamRoot,
          steamId64: config.steamId64,
          steamApiKey: configStore.steamApiKey,
        });
        logger.info(
          {
            restartRequired,
            steamApiKeySet: config.steamApiKeySet,
            steamApiKeySource: config.steamApiKeySource,
          },
          "configuration updated",
        );
      },
    });

    const games = new GamesRepository(database.raw);
    const collections = new SteamCollectionsRepository(database.raw);
    const ruleValues = new RuleValuesRepository(database.raw);
    const rulePreview = new RulePreviewRepository(database.raw);
    const smartCollections = new SmartCollectionsRepository(database.raw);
    const tags = new TagsRepository(database.raw);
    const refresh = new RefreshService({
      db: database.raw,
      steamRoot: configStore.steamRoot,
      steamId64: configStore.steamId64,
      steamApiKey: configStore.steamApiKey,
      ...(options.ownershipSource === undefined
        ? {}
        : { ownershipSource: options.ownershipSource }),
      // Production registration point (#28-#30). Tests replace the set through
      // `metadataSources`; storefront and reviews share the store host.
      sources: options.metadataSources ?? [
        createSteamSpySource(),
        new StorefrontSource(),
        new SteamReviewSource(),
      ],
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      onWarn: (message, details) => logger.warn({ ...details, warning: message }, "scan warning"),
    });
    refreshService = refresh;

    const statusForRequest = (): Status =>
      buildStatus({
        discovery: configStore.discovery,
        steamApiKey: configStore.steamApiKey,
        configuredSteamId64: configStore.steamId64,
        schemaVersion: database!.schemaVersion,
        version: APP_VERSION,
        db: database!.raw,
      });

    const portRef = { value: resolved.port };
    app = createHttpApp({
      port: () => portRef.value,
      clientDir: options.clientDir === undefined ? defaultClientDir() : options.clientDir,
      logger,
      status: statusForRequest,
      library: { games, collections, ruleValues, rulePreview, smartCollections, tags, refresh },
      config: configStore,
    });

    try {
      await app.listen({ port: resolved.port, host: "127.0.0.1" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new StartupError(
          "PORT_IN_USE",
          `Port ${resolved.port} is already in use (${describePortSource(
            resolved.port,
            resolved.portSource,
          )}). Choose another --port.`,
          { cause: error, details: { port: resolved.port } },
        );
      }
      throw new StartupError(
        "INTERNAL_STARTUP",
        `Could not bind 127.0.0.1:${resolved.port}: ${(error as Error).message}`,
        { cause: error },
      );
    }

    const actualPort = listeningPort(app, resolved.port);
    portRef.value = actualPort;
    const url = `http://127.0.0.1:${actualPort}/`;
    configStore.setListening(actualPort, url);

    // §8.7: recover interrupted runs before the startup Fetch. A queued run
    // that never started and a running run both become INTERRUPTED.
    refresh.recoverInterruptedRuns();

    logger.info(
      {
        version: APP_VERSION,
        schemaVersion: database.schemaVersion,
        nodeVersion: process.versions.node,
        dataDir: resolved.dataDir,
        port: actualPort,
        url,
        logLevel: resolved.logLevel,
        logFile: appLogger.filePath ?? logFileTarget,
        openBrowser: resolved.openBrowser,
      },
      "ready",
    );

    // §8.7 startup trigger: one `all` + Fetch after listening, only when a Web
    // API key is configured. Without a key the server waits for onboarding.
    if (configStore.steamApiKey !== null && options.startupRefresh !== false) {
      void refresh.start({ scope: "all", mode: "fetch" }).catch((error: unknown) => {
        logger.warn({ err: error }, "startup Refresh could not be queued");
      });
    }

    if (resolved.openBrowser) {
      openBrowserBestEffort(url, { platform, env, logger });
    }

    let closed = false;
    const running: RunningServer = {
      app,
      logger: appLogger,
      get config(): Config {
        return configStore.get();
      },
      get discovery(): SteamDiscovery {
        return configStore.discovery;
      },
      database,
      port: actualPort,
      url,
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        // §8.9: stop accepting, abort upstream work, let the active run be
        // marked (or finish), then close SQLite, release the lock, and flush
        // the log. Every step runs even when an earlier one fails so a caller
        // never keeps the database or lock open.
        let failure: unknown = null;
        try {
          await app?.close();
        } catch (error) {
          failure = error;
        }
        try {
          await refresh.shutdown();
        } catch (error) {
          failure ??= error;
        }
        database?.close();
        lock?.release();
        try {
          logger.info({}, "shutdown complete");
        } catch {
          // The log sink may already be gone; cleanup continues.
        }
        await appLogger?.close();
        if (failure !== null) {
          throw failure;
        }
      },
    };

    return running;
  } catch (error) {
    if (app !== null) {
      try {
        await app.close();
      } catch {
        // Best effort during startup failure cleanup.
      }
    }
    database?.close();
    lock?.release();
    if (appLogger !== null) {
      await appLogger.close();
    }

    if (isStartupError(error)) {
      throw error;
    }
    throw new StartupError(
      "INTERNAL_STARTUP",
      `game-cat could not start: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/** Default graceful-shutdown budget from §8.9. */
export const SHUTDOWN_WARNING_MS = 5_000;
export const SHUTDOWN_FORCE_MS = 10_000;

export interface LifecycleOptions {
  /** Cleanup still running at this point logs a warning and keeps waiting. */
  warningAfterMs?: number;
  /** Cleanup still running at this point exits non-zero. */
  forceAfterMs?: number;
  /** Test seam; production exits the process. */
  exit?: (code: number) => void;
}

/**
 * `startServer` adds process signal handling on top of `createServer`. Use
 * `createServer` when embedding game-cat in another process (v4 wrapper, tests).
 */
export async function startServer(
  options: ServerOptions = {},
  lifecycle: LifecycleOptions = {},
): Promise<RunningServer> {
  const running = await createServer(options);
  installSignalHandlers(running, lifecycle);
  return running;
}

/**
 * The §8.9 signal sequence. The handlers stay installed while cleanup runs so a
 * second signal can exit immediately; `close()` removes them when it finishes.
 */
export function installSignalHandlers(
  running: RunningServer,
  lifecycle: LifecycleOptions = {},
): void {
  const logger = running.logger.logger;
  const exit = lifecycle.exit ?? ((code: number) => process.exit(code));
  const warningAfterMs = lifecycle.warningAfterMs ?? SHUTDOWN_WARNING_MS;
  const forceAfterMs = lifecycle.forceAfterMs ?? SHUTDOWN_FORCE_MS;
  let stopping = false;
  let warningTimer: NodeJS.Timeout | null = null;
  let forceTimer: NodeJS.Timeout | null = null;

  const clearTimers = (): void => {
    if (warningTimer !== null) {
      clearTimeout(warningTimer);
      warningTimer = null;
    }
    if (forceTimer !== null) {
      clearTimeout(forceTimer);
      forceTimer = null;
    }
  };
  const removeListeners = (): void => {
    for (const signal of SIGNALS) {
      process.off(signal, onSignal);
    }
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      logger.warn({ signal }, "second shutdown signal; exiting now");
      clearTimers();
      removeListeners();
      exit(1);
      return;
    }
    stopping = true;
    logger.info({ signal, warningAfterMs, forceAfterMs }, "shutting down");
    warningTimer = setTimeout(() => {
      logger.warn(
        { signal, elapsedMs: warningAfterMs },
        "shutdown is taking longer than expected; still cleaning up",
      );
    }, warningAfterMs);
    forceTimer = setTimeout(() => {
      logger.error(
        { signal, elapsedMs: forceAfterMs },
        "shutdown exceeded the graceful budget; exiting non-zero",
      );
      clearTimers();
      removeListeners();
      exit(1);
    }, forceAfterMs);
    void running.close().then(
      () => {
        clearTimers();
        exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, "shutdown failed");
        clearTimers();
        exit(1);
      },
    );
  };

  for (const signal of SIGNALS) {
    process.on(signal, onSignal);
  }

  const originalClose = running.close.bind(running);
  running.close = async () => {
    try {
      await originalClose();
    } finally {
      // A programmatic close is not a signal stop, but a signal-triggered close
      // must keep the listeners until cleanup finishes so a second signal is
      // handled immediately rather than by the platform default.
      removeListeners();
      clearTimers();
    }
  };
}

function listeningPort(app: FastifyInstance, fallback: number): number {
  const address = app.server.address();
  if (address !== null && typeof address === "object") {
    return address.port;
  }
  return fallback;
}

function defaultClientDir(): string {
  // src/server in a checkout; dist/server in the build. Both resolve to the
  // sibling client build directory.
  return resolve(import.meta.dirname, "../client");
}

function describePortSource(port: number, source: ResolvedConfig["portSource"]): string {
  switch (source) {
    case "cli":
      return `set by --port ${port}`;
    case "env":
      return `set by GAME_CAT_PORT=${port}`;
    case "file":
      return `set by config.json port ${port}`;
    default:
      return `the default port ${port}`;
  }
}

export { MIN_NODE_MAJOR };
export { createConfigFileSecretStore } from "./config/secrets.ts";
export type { LogLevel };
export type { SecretStore } from "./config/secrets.ts";
