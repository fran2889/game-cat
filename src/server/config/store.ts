import { LOG_LEVELS, type Config, type LogLevel, type SteamAccount } from "../../shared/types.ts";
import { HttpError } from "../errors.ts";
import { discoverSteam, type SteamDiscovery, type SteamDiscoveryFn } from "../steam/discovery.ts";
import type { FileConfig, ResolvedConfig } from "./load.ts";
import { expandHome, isAbsolutePath } from "./paths.ts";
import { createConfigFileSecretStore, type SecretStore } from "./secrets.ts";
import { writeConfigAtomically } from "./write.ts";

export interface ConfigStoreOptions {
  resolved: ResolvedConfig;
  discovery: SteamDiscovery;
  /** The actual listening port. `port: 0` is resolved only after `listen()`. */
  port: number;
  listeningUrl: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  discover?: SteamDiscoveryFn;
  setLogLevel?: (level: LogLevel) => void;
  /** Read dynamically so a first run can bind the Account after startup. */
  boundSteamId64?: () => string | null;
  onChange?: (config: Config, restartRequired: boolean) => void;
  /**
   * Replaceable key storage (§8.10 item 8). The default reads and writes the
   * `steamApiKey` field in `config.json`; a wrapper can inject the OS keychain.
   */
  secretStore?: SecretStore;
}

export interface ConfigPatchResult {
  data: Config;
  meta: { restartRequired: boolean };
}

const PATCH_FIELDS = new Set([
  "steamApiKey",
  "steamRoot",
  "steamId64",
  "port",
  "openBrowser",
  "logLevel",
]);

function validationError(fieldErrors: Record<string, string>): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", "Request body is invalid", {
    details: { fieldErrors },
  });
}

/**
 * The live, non-secret configuration view and the atomic `PATCH /api/config`
 * writer (spec §4.3, §8.3). The key is held here for the Refresh service only
 * and never crosses the API boundary.
 */
export class ConfigStore {
  readonly dataDir: string;
  readonly configPath: string;

  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homedir: string;
  private readonly discover: SteamDiscoveryFn;
  private readonly setLogLevel: ((level: LogLevel) => void) | undefined;
  private readonly boundSteamId64: (() => string | null) | undefined;
  private readonly onChange: ((config: Config, restartRequired: boolean) => void) | undefined;
  private readonly secretStore: SecretStore;

  private fileConfig: FileConfig;
  private currentDiscovery: SteamDiscovery;
  private apiKey: string | null;
  private apiKeySource: "file" | "env" | "none";
  private effectiveSteamRoot: string | null;
  private effectiveSteamId64: string | null;
  private configuredSteamRoot: string | null;
  private configuredSteamId64: string | null;
  private currentPort: number;
  private currentListeningUrl: string;
  private currentOpenBrowser: boolean;
  private currentLogLevel: LogLevel;

  constructor(options: ConfigStoreOptions) {
    this.dataDir = options.resolved.dataDir;
    this.configPath = options.resolved.configPath;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.homedir = options.homedir ?? "";
    this.discover = options.discover ?? discoverSteam;
    this.setLogLevel = options.setLogLevel;
    this.boundSteamId64 = options.boundSteamId64;
    this.onChange = options.onChange;

    this.fileConfig = { ...options.resolved.fileConfig };
    if (options.secretStore !== undefined && options.secretStore.storage === "external") {
      // The external store owns the key; never leave a stale copy in the file.
      delete this.fileConfig.steamApiKey;
    }
    this.secretStore =
      options.secretStore ??
      createConfigFileSecretStore({
        configPath: this.configPath,
        platform: this.platform,
        readDocument: () => this.fileConfig,
        commitDocument: (document) => {
          this.fileConfig = document;
        },
      });

    // Precedence is environment, then a programmatic option, then the store
    // (which is `config.json` by default).
    const environmentKey =
      options.resolved.steamApiKeySource === "env" ? options.resolved.steamApiKey : null;
    const programmaticKey =
      options.resolved.steamApiKeySource !== "env" &&
      options.resolved.steamApiKey !== null &&
      options.resolved.steamApiKey !== options.resolved.fileConfig.steamApiKey;
    if (environmentKey !== null) {
      this.apiKey = environmentKey;
      this.apiKeySource = "env";
    } else if (programmaticKey) {
      this.apiKey = options.resolved.steamApiKey;
      this.apiKeySource = "file";
    } else {
      const stored =
        options.secretStore === undefined
          ? options.resolved.steamApiKey
          : options.secretStore.read();
      this.apiKey = stored;
      this.apiKeySource = stored === null ? "none" : "file";
    }
    this.currentDiscovery = options.discovery;
    this.configuredSteamRoot = options.resolved.steamRoot;
    this.configuredSteamId64 = options.resolved.steamId64;
    this.effectiveSteamRoot = options.discovery.root ?? options.resolved.steamRoot;
    this.effectiveSteamId64 = options.discovery.account?.steamId64 ?? options.resolved.steamId64;
    this.currentPort = options.port;
    this.currentListeningUrl = options.listeningUrl;
    this.currentOpenBrowser = options.resolved.openBrowser;
    this.currentLogLevel = options.resolved.logLevel;
  }

  /** The non-secret public `Config` shape. Never includes the key or a prefix. */
  get(): Config {
    return {
      dataDir: this.dataDir,
      steamRoot: this.effectiveSteamRoot,
      steamId64: this.effectiveSteamId64,
      port: this.currentPort,
      listeningUrl: this.currentListeningUrl,
      openBrowser: this.currentOpenBrowser,
      logLevel: this.currentLogLevel,
      steamApiKeySet: this.apiKey !== null,
      steamApiKeySource: this.apiKeySource,
    };
  }

  get discovery(): SteamDiscovery {
    return this.currentDiscovery;
  }

  get steamRoot(): string | null {
    return this.effectiveSteamRoot;
  }

  get steamId64(): string | null {
    return this.effectiveSteamId64;
  }

  /** Server-side only. Never serialized into a response or a log line. */
  get steamApiKey(): string | null {
    return this.apiKey;
  }

  setListening(port: number, listeningUrl: string): void {
    this.currentPort = port;
    this.currentListeningUrl = listeningUrl;
  }

  /** Read `loginusers.vdf` for the account picker. `AccountName` is never read. */
  accounts(): SteamAccount[] {
    const found = this.discover({
      steamRoot: this.effectiveSteamRoot,
      steamId64: null,
      platform: this.platform,
      env: this.env,
      homedir: this.homedir,
    });
    return found.accounts;
  }

  /**
   * Validate and persist any subset of the editable settings. The file write is
   * atomic and 0600; a rejected request writes nothing.
   */
  patch(body: unknown): ConfigPatchResult {
    const record = this.patchRecord(body);
    const before = this.get();
    const restartRequired =
      record.port !== undefined && (record.port as number) !== this.currentPort;

    if (Object.keys(record).length === 0) {
      return { data: before, meta: { restartRequired: false } };
    }

    // The environment key wins over the file, so a file write would be dead.
    if (record.steamApiKey !== undefined && this.apiKeySource === "env") {
      throw validationError({ steamApiKey: "managed by GAME_CAT_STEAM_API_KEY" });
    }

    if (record.steamId64 !== undefined) {
      const bound = this.boundSteamId64?.() ?? null;
      if (bound !== null && record.steamId64 !== bound) {
        throw new HttpError(
          409,
          "ACCOUNT_BOUND",
          "The database is bound to a different Steam Account. Switching Accounts requires a new data directory.",
          { details: { boundSteamId64: bound } },
        );
      }
    }

    const keyChanged = record.steamApiKey !== undefined;
    const nextFileConfig: FileConfig = { ...this.fileConfig };
    if (keyChanged && this.secretStore.storage === "config-file") {
      nextFileConfig.steamApiKey = record.steamApiKey as string;
    }
    if (record.steamRoot !== undefined) {
      nextFileConfig.steamRoot = record.steamRoot as string;
    }
    if (record.steamId64 !== undefined) {
      nextFileConfig.steamId64 = record.steamId64 as string;
    }
    if (record.port !== undefined) {
      nextFileConfig.port = record.port as number;
    }
    if (record.openBrowser !== undefined) {
      nextFileConfig.openBrowser = record.openBrowser as boolean;
    }
    if (record.logLevel !== undefined) {
      nextFileConfig.logLevel = record.logLevel as LogLevel;
    }

    const previousFileConfig = this.fileConfig;
    const previousApiKey = this.apiKey;
    this.fileConfig = nextFileConfig;
    try {
      if (keyChanged) {
        // The store merges/persists the key. A file-backed store also writes
        // the non-secret fields collected above; an external store does not.
        this.secretStore.write(record.steamApiKey as string);
        if (this.secretStore.storage !== "config-file") {
          writeConfigAtomically(this.configPath, nextFileConfig, this.platform);
        }
      } else {
        writeConfigAtomically(this.configPath, nextFileConfig, this.platform);
      }
    } catch {
      this.fileConfig = previousFileConfig;
      this.apiKey = previousApiKey;
      throw new HttpError(500, "INTERNAL_ERROR", "The configuration could not be saved.");
    }

    if (keyChanged) {
      this.apiKey = record.steamApiKey as string;
      this.apiKeySource = "file";
    }
    if (record.openBrowser !== undefined) {
      this.currentOpenBrowser = record.openBrowser as boolean;
    }
    if (record.port !== undefined) {
      this.currentPort = record.port as number;
    }
    if (record.logLevel !== undefined) {
      this.currentLogLevel = record.logLevel as LogLevel;
      this.setLogLevel?.(this.currentLogLevel);
    }

    const rootChanged = record.steamRoot !== undefined;
    const accountChanged = record.steamId64 !== undefined;
    if (rootChanged) {
      this.configuredSteamRoot = record.steamRoot as string;
      this.effectiveSteamRoot = record.steamRoot as string;
    }
    if (accountChanged) {
      this.configuredSteamId64 = record.steamId64 as string;
      this.effectiveSteamId64 = record.steamId64 as string;
    }
    if (rootChanged || accountChanged) {
      this.refreshDiscovery();
    }

    const after = this.get();
    this.onChange?.(after, restartRequired);
    return { data: after, meta: { restartRequired } };
  }

  private patchRecord(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw validationError({ body: "must be an object" });
    }
    const record = body as Record<string, unknown>;
    const fieldErrors: Record<string, string> = {};
    const present: Record<string, unknown> = {};

    for (const key of Object.keys(record)) {
      if (!PATCH_FIELDS.has(key)) {
        fieldErrors[key] = "is not a recognized configuration key";
      }
    }

    if (record.steamApiKey !== undefined) {
      if (typeof record.steamApiKey !== "string" || record.steamApiKey.trim() === "") {
        fieldErrors.steamApiKey = "must be a non-empty string";
      } else {
        present.steamApiKey = record.steamApiKey;
      }
    }

    if (record.steamRoot !== undefined) {
      if (typeof record.steamRoot !== "string" || record.steamRoot.trim() === "") {
        fieldErrors.steamRoot = "must be a non-empty absolute path";
      } else {
        const expanded = expandHome(record.steamRoot, this.homedir);
        if (!isAbsolutePath(expanded)) {
          fieldErrors.steamRoot = "must be an absolute path";
        } else {
          present.steamRoot = expanded;
        }
      }
    }

    if (record.steamId64 !== undefined) {
      if (typeof record.steamId64 !== "string" || !/^\d{17}$/.test(record.steamId64)) {
        fieldErrors.steamId64 = "must be a 17-digit SteamID64";
      } else {
        present.steamId64 = record.steamId64;
      }
    }

    if (record.port !== undefined) {
      if (
        typeof record.port !== "number" ||
        !Number.isInteger(record.port) ||
        record.port < 0 ||
        record.port > 65535
      ) {
        fieldErrors.port = "must be an integer between 0 and 65535";
      } else {
        present.port = record.port;
      }
    }

    if (record.openBrowser !== undefined) {
      if (typeof record.openBrowser !== "boolean") {
        fieldErrors.openBrowser = "must be a boolean";
      } else {
        present.openBrowser = record.openBrowser;
      }
    }

    if (record.logLevel !== undefined) {
      if (
        typeof record.logLevel !== "string" ||
        !(LOG_LEVELS as readonly string[]).includes(record.logLevel)
      ) {
        fieldErrors.logLevel = `must be one of ${LOG_LEVELS.join(", ")}`;
      } else {
        present.logLevel = record.logLevel;
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw validationError(fieldErrors);
    }
    return present;
  }

  /** Re-run read-only discovery after a root or Account change. */
  private refreshDiscovery(): void {
    const discovered = this.discover({
      steamRoot: this.configuredSteamRoot,
      steamId64: this.configuredSteamId64,
      platform: this.platform,
      env: this.env,
      homedir: this.homedir,
    });
    this.currentDiscovery = discovered;
    this.effectiveSteamRoot = discovered.root ?? this.configuredSteamRoot;
    this.effectiveSteamId64 = discovered.account?.steamId64 ?? this.configuredSteamId64;
  }
}
