import { readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { LOG_LEVELS, type LogLevel } from "../../shared/types.ts";
import { StartupError } from "../errors.ts";
import { defaultDataDir, expandHome, isAbsolutePath, resolveUserPath } from "./paths.ts";

/** The keys allowed in `<data-dir>/config.json`, per spec §8.3. */
export interface FileConfig {
  steamApiKey?: string;
  steamRoot?: string;
  steamId64?: string;
  port?: number;
  openBrowser?: boolean;
  logLevel?: LogLevel;
}

export interface ConfigOverrides {
  dataDir?: string;
  steamApiKey?: string;
  steamRoot?: string;
  steamId64?: string;
  port?: number | string;
  openBrowser?: boolean;
  logLevel?: string;
}

export interface LoadConfigOptions {
  overrides?: ConfigOverrides;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  cwd?: string;
}

export type SettingSource = "cli" | "env" | "file" | "default";

export interface ResolvedConfig {
  dataDir: string;
  configPath: string;
  configFileExists: boolean;
  fileConfig: FileConfig;
  steamApiKey: string | null;
  steamApiKeySource: "file" | "env" | "none";
  /** Configured Steam root, before discovery. `null` means auto-discover. */
  steamRoot: string | null;
  steamId64: string | null;
  port: number;
  portSource: SettingSource;
  openBrowser: boolean;
  openBrowserSource: SettingSource;
  logLevel: LogLevel;
  logLevelSource: SettingSource;
  warnings: string[];
}

const ALLOWED_KEYS = new Set([
  "steamApiKey",
  "steamRoot",
  "steamId64",
  "port",
  "openBrowser",
  "logLevel",
]);

function invalid(configPath: string, field: string, message: string): never {
  throw new StartupError("CONFIG_INVALID", `${configPath}: ${field} ${message}`, {
    details: { fieldErrors: { [field]: message } },
  });
}

function readConfigFile(configPath: string): { config: FileConfig; exists: boolean } {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: {}, exists: false };
    }
    throw new StartupError(
      "CONFIG_INVALID",
      `${configPath}: cannot read configuration file: ${(error as Error).message}`,
      { cause: error },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StartupError(
      "CONFIG_INVALID",
      `${configPath}: invalid JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
  return { config: validateFileConfig(raw, configPath), exists: true };
}

export function validateFileConfig(raw: unknown, configPath: string): FileConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StartupError("CONFIG_INVALID", `${configPath}: expected a JSON object`);
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      invalid(configPath, key, "is not a recognized configuration key");
    }
  }

  const config: FileConfig = {};

  if (record.steamApiKey !== undefined) {
    config.steamApiKey = requireNonEmptyString(record.steamApiKey, "steamApiKey", configPath);
  }
  if (record.steamRoot !== undefined) {
    config.steamRoot = requireAbsolutePath(record.steamRoot, "steamRoot", configPath);
  }
  if (record.steamId64 !== undefined) {
    config.steamId64 = requireSteamId64(record.steamId64, "steamId64", configPath);
  }
  if (record.port !== undefined) {
    if (typeof record.port !== "number") {
      invalid(configPath, "port", "must be an integer between 0 and 65535");
    }
    config.port = requirePort(record.port, "port", configPath);
  }
  if (record.openBrowser !== undefined) {
    if (typeof record.openBrowser !== "boolean") {
      invalid(configPath, "openBrowser", "must be a boolean");
    }
    config.openBrowser = record.openBrowser;
  }
  if (record.logLevel !== undefined) {
    config.logLevel = requireLogLevel(record.logLevel, "logLevel", configPath);
  }

  return config;
}

function requireNonEmptyString(value: unknown, field: string, configPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(configPath, field, "must be a non-empty string");
  }
  return value;
}

function requireAbsolutePath(value: unknown, field: string, configPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(configPath, field, "must be a non-empty absolute path");
  }
  const expanded = expandHome(value, "");
  if (!isAbsolutePath(expanded)) {
    invalid(configPath, field, "must be an absolute path");
  }
  return value;
}

function requireSteamId64(value: unknown, field: string, configPath: string): string {
  if (typeof value !== "string" || !/^\d{17}$/.test(value)) {
    invalid(configPath, field, "must be a 17-digit SteamID64");
  }
  return value;
}

function requirePort(value: number, field: string, configPath: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    invalid(configPath, field, "must be an integer between 0 and 65535");
  }
  return value;
}

function requireLogLevel(value: unknown, field: string, configPath: string): LogLevel {
  if (typeof value !== "string" || !(LOG_LEVELS as readonly string[]).includes(value)) {
    invalid(configPath, field, `must be one of ${LOG_LEVELS.join(", ")}`);
  }
  return value as LogLevel;
}

function parsePortValue(value: unknown, field: string, label: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new StartupError(
      "CONFIG_INVALID",
      `${label}: ${field} must be an integer between 0 and 65535`,
      { details: { fieldErrors: { [field]: "must be an integer between 0 and 65535" } } },
    );
  }
  return parsed;
}

function parseBooleanValue(value: string, field: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  throw new StartupError("CONFIG_INVALID", `GAME_CAT_${field}: must be one of 1, true, 0, false`, {
    details: { fieldErrors: { [field]: "must be one of 1, true, 0, false" } },
  });
}

function parseEnvLogLevel(value: string): LogLevel {
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    throw new StartupError(
      "CONFIG_INVALID",
      `GAME_CAT_LOG_LEVEL: must be one of ${LOG_LEVELS.join(", ")}`,
      { details: { fieldErrors: { logLevel: "unsupported log level" } } },
    );
  }
  return value as LogLevel;
}

function parseEnvSteamId64(value: string): string {
  if (!/^\d{17}$/.test(value)) {
    throw new StartupError("CONFIG_INVALID", "GAME_CAT_STEAM_ID64: must be a 17-digit SteamID64", {
      details: { fieldErrors: { steamId64: "must be a 17-digit SteamID64" } },
    });
  }
  return value;
}

function requireEnvNonEmpty(value: string, field: string): string {
  if (value.trim() === "") {
    throw new StartupError("CONFIG_INVALID", `GAME_CAT_${field}: must not be empty`, {
      details: { fieldErrors: { [field]: "must not be empty" } },
    });
  }
  return value;
}

/**
 * Load configuration with the documented precedence (§8.3):
 * CLI/programmatic overrides, then environment, then `config.json`, then defaults.
 *
 * Every supplied layer is validated even when a higher layer wins. That keeps a
 * stale or mistyped value from silently changing behavior later.
 */
export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? osHomedir();
  const cwd = options.cwd ?? process.cwd();
  const overrides = options.overrides ?? {};

  // Data dir is resolved before the config file is read. Programmatic overrides
  // get the same runtime type checks as the CLI and environment.
  if (env.GAME_CAT_DATA_DIR !== undefined && env.GAME_CAT_DATA_DIR.trim() === "") {
    throw new StartupError("CONFIG_INVALID", "GAME_CAT_DATA_DIR: must not be empty", {
      details: { fieldErrors: { dataDir: "must not be empty" } },
    });
  }
  if (
    overrides.dataDir !== undefined &&
    (typeof overrides.dataDir !== "string" || overrides.dataDir.trim() === "")
  ) {
    throw new StartupError("CONFIG_INVALID", "dataDir must be a non-empty string", {
      details: { fieldErrors: { dataDir: "must be a non-empty string" } },
    });
  }
  const dataDirInput = overrides.dataDir ?? env.GAME_CAT_DATA_DIR;
  const dataDir =
    dataDirInput === undefined
      ? defaultDataDir(platform, env, home)
      : resolveUserPath(dataDirInput, home, cwd);

  const configPath = join(dataDir, "config.json");
  const { config: fileConfig, exists: configFileExists } = readConfigFile(configPath);
  const warnings: string[] = [];

  const envSteamRoot = env.GAME_CAT_STEAM_ROOT;
  if (envSteamRoot !== undefined) {
    requireEnvNonEmpty(envSteamRoot, "STEAM_ROOT");
    const expanded = expandHome(envSteamRoot, home);
    if (!isAbsolutePath(expanded)) {
      throw new StartupError("CONFIG_INVALID", "GAME_CAT_STEAM_ROOT: must be an absolute path", {
        details: { fieldErrors: { steamRoot: "must be an absolute path" } },
      });
    }
  }

  const overrideSteamRoot = overrides.steamRoot;
  if (overrideSteamRoot !== undefined) {
    if (overrideSteamRoot.trim() === "") {
      throw new StartupError("CONFIG_INVALID", "steamRoot must not be empty", {
        details: { fieldErrors: { steamRoot: "must not be empty" } },
      });
    }
    if (!isAbsolutePath(expandHome(overrideSteamRoot, home))) {
      throw new StartupError("CONFIG_INVALID", "steamRoot must be an absolute path", {
        details: { fieldErrors: { steamRoot: "must be an absolute path" } },
      });
    }
  }

  const envSteamId64 =
    env.GAME_CAT_STEAM_ID64 === undefined ? undefined : parseEnvSteamId64(env.GAME_CAT_STEAM_ID64);
  if (overrides.steamId64 !== undefined && !/^\d{17}$/.test(overrides.steamId64)) {
    throw new StartupError("CONFIG_INVALID", "steamId64 must be a 17-digit SteamID64", {
      details: { fieldErrors: { steamId64: "must be a 17-digit SteamID64" } },
    });
  }

  const envApiKey =
    env.GAME_CAT_STEAM_API_KEY === undefined
      ? undefined
      : requireEnvNonEmpty(env.GAME_CAT_STEAM_API_KEY, "STEAM_API_KEY");
  if (overrides.steamApiKey !== undefined && overrides.steamApiKey.trim() === "") {
    throw new StartupError("CONFIG_INVALID", "steamApiKey must not be empty", {
      details: { fieldErrors: { steamApiKey: "must not be empty" } },
    });
  }

  const envPort =
    env.GAME_CAT_PORT === undefined
      ? undefined
      : parsePortValue(env.GAME_CAT_PORT, "port", "GAME_CAT_PORT");
  const overridePort =
    overrides.port === undefined ? undefined : parsePortValue(overrides.port, "port", "--port");

  let port = 4780;
  let portSource: SettingSource = "default";
  if (fileConfig.port !== undefined) {
    port = fileConfig.port;
    portSource = "file";
  }
  if (envPort !== undefined) {
    port = envPort;
    portSource = "env";
  }
  if (overridePort !== undefined) {
    port = overridePort;
    portSource = "cli";
  }

  const envOpenBrowser =
    env.GAME_CAT_OPEN_BROWSER === undefined
      ? undefined
      : parseBooleanValue(env.GAME_CAT_OPEN_BROWSER, "OPEN_BROWSER");

  let openBrowser = true;
  let openBrowserSource: SettingSource = "default";
  if (fileConfig.openBrowser !== undefined) {
    openBrowser = fileConfig.openBrowser;
    openBrowserSource = "file";
  }
  if (envOpenBrowser !== undefined) {
    openBrowser = envOpenBrowser;
    openBrowserSource = "env";
  }
  if (overrides.openBrowser !== undefined) {
    openBrowser = overrides.openBrowser;
    openBrowserSource = "cli";
  }

  const envLogLevel =
    env.GAME_CAT_LOG_LEVEL === undefined ? undefined : parseEnvLogLevel(env.GAME_CAT_LOG_LEVEL);
  if (overrides.logLevel !== undefined) {
    requireLogLevel(overrides.logLevel, "logLevel", "options");
  }

  let logLevel: LogLevel = "info";
  let logLevelSource: SettingSource = "default";
  if (fileConfig.logLevel !== undefined) {
    logLevel = fileConfig.logLevel;
    logLevelSource = "file";
  }
  if (envLogLevel !== undefined) {
    logLevel = envLogLevel;
    logLevelSource = "env";
  }
  if (overrides.logLevel !== undefined) {
    logLevel = overrides.logLevel as LogLevel;
    logLevelSource = "cli";
  }

  const effectiveApiKey = envApiKey ?? overrides.steamApiKey ?? fileConfig.steamApiKey ?? null;
  const steamApiKeySource: "file" | "env" | "none" =
    envApiKey !== undefined
      ? "env"
      : overrides.steamApiKey !== undefined
        ? "file"
        : fileConfig.steamApiKey !== undefined
          ? "file"
          : "none";

  const effectiveSteamRoot = overrideSteamRoot ?? envSteamRoot ?? fileConfig.steamRoot ?? null;
  const effectiveSteamId64 = overrides.steamId64 ?? envSteamId64 ?? fileConfig.steamId64 ?? null;

  return {
    dataDir,
    configPath,
    configFileExists,
    fileConfig,
    steamApiKey: effectiveApiKey,
    steamApiKeySource,
    steamRoot: effectiveSteamRoot === null ? null : expandHome(effectiveSteamRoot, home),
    steamId64: effectiveSteamId64,
    port,
    portSource,
    openBrowser,
    openBrowserSource,
    logLevel,
    logLevelSource,
    warnings,
  };
}
