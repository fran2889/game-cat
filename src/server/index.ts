import { homedir as osHomedir } from "node:os";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { APP_VERSION, MIN_NODE_MAJOR } from "../shared/app.ts";
import type { Config, LogLevel, Status } from "../shared/types.ts";
import { loadConfig, type ConfigOverrides, type ResolvedConfig } from "./config/load.ts";
import { assertDataDirOutsideSteam, prepareDataDir } from "./config/data-dir.ts";
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
   * Test seam: skip the documented startup `all` + Fetch trigger. Recovery of
   * interrupted runs still happens.
   */
  startupRefresh?: boolean;
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
    keySource: resolved.steamApiKeySource,
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
      steamWebApiConfigured: resolved.steamApiKey !== null && selectedSteamId64 !== null,
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
      library: { games, collections, ruleValues, rulePreview, tags, refresh },
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
        // §8.9: stop accepting, mark the active run, then close SQLite and
        // release the lock.
        await app?.close();
        await refresh.shutdown();
        database?.close();
        lock?.release();
        await appLogger?.close();
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

/**
 * `startServer` adds process signal handling on top of `createServer`. Use
 * `createServer` when embedding game-cat in another process (v4 wrapper, tests).
 */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const running = await createServer(options);
  installSignalHandlers(running);
  return running;
}

function installSignalHandlers(running: RunningServer): void {
  let stopping = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      running.logger.logger.warn({ signal }, "second shutdown signal; exiting now");
      process.exit(1);
    }
    stopping = true;
    running.logger.logger.info({ signal }, "shutting down");
    void running
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        running.logger.logger.error({ err: error }, "shutdown failed");
        process.exit(1);
      });
  };

  for (const signal of SIGNALS) {
    process.on(signal, onSignal);
  }
  const originalClose = running.close.bind(running);
  running.close = async () => {
    for (const signal of SIGNALS) {
      process.off(signal, onSignal);
    }
    await originalClose();
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
export type { LogLevel };
