import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { StartupError } from "../errors.ts";
import { isInside } from "./paths.ts";

export interface PrepareDataDirOptions {
  dataDir: string;
  configPath: string;
  configFileExists: boolean;
  keySource: "file" | "env" | "none";
  platform?: NodeJS.Platform;
  /** Test seam for permission failures. Defaults to `fs.chmodSync`. */
  chmod?: (path: string, mode: number) => void;
}

export interface PreparedDataDir {
  created: boolean;
  warnings: string[];
}

function notWritable(path: string, error: unknown): StartupError {
  return new StartupError(
    "DATA_DIR_NOT_WRITABLE",
    `Cannot create or write the data directory at ${path}: ${(error as Error).message}`,
    { cause: error },
  );
}

/**
 * The data directory, `backups/`, and `logs/` are 0700 (§8.3), including when
 * the path already existed with a looser mode. The database and the key live
 * below this directory, so failing to tighten it is a startup failure rather
 * than a warning.
 */
function ensureDirectoryMode(path: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    return;
  }
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      chmodSync(path, 0o700);
    }
  } catch (error) {
    throw notWritable(path, error);
  }
}

/**
 * Create the documented layout before the lock is taken:
 * `<data-dir>/` 0700, `backups/` 0700, `logs/` 0700, and `config.json` 0600.
 *
 * A missing config file is created atomically (same-directory temporary file,
 * then rename) so a crash never leaves a half-written config behind.
 */
export function prepareDataDir(options: PrepareDataDirOptions): PreparedDataDir {
  const { dataDir, configPath } = options;
  const platform = options.platform ?? process.platform;
  const chmod = options.chmod ?? chmodSync;
  const warnings: string[] = [];

  const existedBefore = existsSync(dataDir);
  if (existedBefore && !statSync(dataDir).isDirectory()) {
    throw notWritable(dataDir, new Error("path exists and is not a directory"));
  }

  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw notWritable(dataDir, error);
  }
  ensureDirectoryMode(dataDir, platform);

  for (const name of ["backups", "logs"] as const) {
    const path = join(dataDir, name);
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw notWritable(path, error);
    }
    ensureDirectoryMode(path, platform);
  }

  if (!options.configFileExists && !existsSync(configPath)) {
    const tempPath = join(dataDir, `.config.json.tmp-${process.pid}-${Date.now().toString(36)}`);
    try {
      writeFileSync(tempPath, "{}\n", { mode: 0o600 });
      if (platform !== "win32") {
        chmodSync(tempPath, 0o600);
      }
      renameSync(tempPath, configPath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best effort; the original failure is what matters.
      }
      throw notWritable(configPath, error);
    }
  }

  // An existing readable config may contain the Steam Web API key. Tighten it
  // to 0600. If that fails and the key is in the file, refuse to run with a
  // world-readable secret (§8.3 "Permissions").
  if (platform !== "win32" && existsSync(configPath)) {
    let needsTightening = false;
    try {
      needsTightening = (statSync(configPath).mode & 0o077) !== 0;
    } catch (error) {
      throw notWritable(configPath, error);
    }

    if (needsTightening) {
      try {
        chmod(configPath, 0o600);
      } catch (error) {
        if (options.keySource === "file") {
          throw new StartupError(
            "CONFIG_PERMISSIONS",
            `The Steam Web API key in ${configPath} is readable by other users and ` +
              `could not be tightened to 0600: ${(error as Error).message}`,
            { cause: error },
          );
        }
        warnings.push(
          `Could not tighten ${configPath} to 0600; the key is supplied by the environment, so startup continues.`,
        );
      }
    }
  }

  return { created: !existedBefore, warnings };
}

/**
 * Refuse a data directory inside the Steam tree. v1 never writes inside Steam
 * (§8.3), so this check runs before the data directory is created.
 */
export function assertDataDirOutsideSteam(dataDir: string, steamRoot: string | null): void {
  if (steamRoot === null) {
    return;
  }
  if (isInside(steamRoot, dataDir)) {
    throw new StartupError(
      "DATA_DIR_IN_STEAM",
      `The data directory ${dataDir} resolves inside the Steam root ${steamRoot}. ` +
        `Choose a path outside the Steam tree.`,
      { details: { dataDir, steamRoot } },
    );
  }
}
