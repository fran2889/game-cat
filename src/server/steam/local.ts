import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getVdfNumber, getVdfObject, getVdfString, parseVdf, type VdfObject } from "./vdf.ts";

/**
 * Read-only access to a Steam installation's local library files.
 *
 * Every function here opens files read-only. Nothing is created, repaired, or
 * locked inside the Steam tree, which is required by spec §6.10 step 9 and
 * AC-L15. Failures are collected as warnings so a missing library or a
 * malformed file can degrade a scan to `partial` instead of losing data.
 */

export interface SteamLibrary {
  /** The path as discovered (or the configured root); used for display. */
  path: string;
  /** The resolved path used for de-duplication and install checks. */
  realPath: string;
  readable: boolean;
}

export interface LocalManifest {
  appId: number;
  name: string | null;
  stateFlags: number;
  installDir: string | null;
  installed: boolean;
  sizeOnDiskBytes: number | null;
  manifestLastPlayedAt: number | null;
  lastUpdatedAt: number | null;
  libraryPath: string;
}

export interface LocalPlaytimeEntry {
  appId: number;
  playtimeMinutes: number | null;
  playtime2weeksMinutes: number | null;
  lastPlayedAt: number | null;
}

export interface LocalScanWarning {
  code: string;
  message: string;
  path?: string;
}

export interface LocalLibrarySnapshot {
  root: string;
  found: boolean;
  /** In discovery order, with the Steam root first, de-duplicated by realpath. */
  libraries: SteamLibrary[];
  manifests: LocalManifest[];
  /** `null` means the file was not read completely. */
  localConfigEntries: LocalPlaytimeEntry[] | null;
  accountId: string | null;
  accountDir: string | null;
  manifestsComplete: boolean;
  localConfigComplete: boolean;
  negativePlaytimeCount: number;
  warnings: LocalScanWarning[];
}

export interface ReadSteamLocalOptions {
  steamRoot: string;
  steamId64: string | null;
}

const MANIFEST_PATTERN = /^appmanifest_(\d+)\.acf$/i;
const DIGITS = /^\d+$/;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveReal(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function warn(warnings: LocalScanWarning[], code: string, message: string, path?: string): void {
  warnings.push(path === undefined ? { code, message } : { code, message, path });
}

/** Read a whole file, retrying if Steam rewrites it while we read (§8). */
function readStable(path: string, warnings: LocalScanWarning[], attempts = 3): string | null {
  let last: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const before = statSync(path);
      last = readFileSync(path, "utf8");
      const after = statSync(path);
      if (before.mtimeMs === after.mtimeMs && before.size === after.size) {
        return last;
      }
    } catch (error) {
      warn(
        warnings,
        "file_unreadable",
        `Could not read ${path}: ${(error as Error).message}`,
        path,
      );
      return null;
    }
  }
  if (last !== null) {
    warn(
      warnings,
      "file_changed_during_read",
      `${path} changed while it was being read; using the last snapshot.`,
      path,
    );
  }
  return last;
}

function parseVdfSafe(
  text: string,
  expectedRoot: string,
  path: string,
  warnings: LocalScanWarning[],
): VdfObject | null {
  let document: VdfObject;
  try {
    document = parseVdf(text);
  } catch (error) {
    warn(warnings, "vdf_malformed", `Could not parse ${path}: ${(error as Error).message}`, path);
    return null;
  }
  const root = getVdfObject(document, expectedRoot);
  if (root === undefined) {
    warn(
      warnings,
      "vdf_root_missing",
      `${path} does not contain the expected ${expectedRoot} root.`,
      path,
    );
    return null;
  }
  return root;
}

interface ResolvedLibrary {
  path: string;
  realPath: string;
  readable: boolean;
}

function discoverLibraries(
  root: string,
  warnings: LocalScanWarning[],
): { libraries: ResolvedLibrary[]; complete: boolean } {
  const discovered: ResolvedLibrary[] = [];
  const seen = new Set<string>();

  const add = (path: string, readable?: boolean): void => {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const realPath = resolveReal(absolute) ?? absolute;
    const identity = process.platform === "win32" ? realPath.toLowerCase() : realPath;
    if (seen.has(identity)) {
      return;
    }
    seen.add(identity);
    discovered.push({
      path: absolute,
      realPath,
      readable: readable ?? isDirectory(join(realPath, "steamapps")),
    });
  };

  // The Steam root is always an implicit library, even without libraryfolders.
  add(root);

  const candidates = [
    join(root, "config", "libraryfolders.vdf"),
    join(root, "steamapps", "libraryfolders.vdf"),
  ];
  const file = candidates.find(isFile);
  if (file === undefined) {
    return { libraries: discovered, complete: true };
  }

  const text = readStable(file, warnings);
  if (text === null) {
    return { libraries: discovered, complete: false };
  }
  const document = parseVdfSafe(text, "libraryfolders", file, warnings);
  if (document === null) {
    return { libraries: discovered, complete: false };
  }

  let complete = true;
  for (const [key, value] of Object.entries(document)) {
    if (!DIGITS.test(key)) {
      continue;
    }
    let path: string | undefined;
    if (typeof value === "string") {
      // Legacy pre-2021 schema: "<index>" "<path>".
      path = value;
    } else {
      path = getVdfString(value, "path");
    }
    if (path === undefined || path.trim() === "") {
      complete = false;
      warn(warnings, "library_path_missing", `Library entry ${key} in ${file} has no path.`, file);
      continue;
    }
    add(path);
  }

  for (const library of discovered) {
    if (!library.readable) {
      complete = false;
      warn(
        warnings,
        "library_unreadable",
        `Library ${library.path} has no readable steamapps directory.`,
        library.path,
      );
    }
  }

  return { libraries: discovered, complete };
}

function positiveOrNull(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

function parseManifest(
  appId: number,
  filePath: string,
  libraryPath: string,
  text: string,
  warnings: LocalScanWarning[],
): LocalManifest | null {
  const state = parseVdfSafe(text, "appstate", filePath, warnings);
  if (state === null) {
    return null;
  }

  const declaredAppId = getVdfNumber(state, "appid");
  if (declaredAppId !== appId) {
    warn(
      warnings,
      "manifest_appid_mismatch",
      `${filePath} declares appid ${String(declaredAppId)}, which does not match its file name.`,
      filePath,
    );
    return null;
  }

  const installDir = getVdfString(state, "installdir") ?? null;
  const stateFlags = Math.max(0, getVdfNumber(state, "stateflags") ?? 0);
  const depots = getVdfObject(state, "installeddepots");
  const depotsPresent = depots !== undefined && Object.keys(depots).length > 0;
  const installDirectoryExists =
    installDir !== null && isDirectory(join(libraryPath, "steamapps", "common", installDir));

  const rawSize = getVdfNumber(state, "sizeondisk");
  const name = getVdfString(state, "name")?.trim() ?? "";

  return {
    appId,
    name: name === "" ? null : name,
    stateFlags,
    installDir,
    installed: (stateFlags & 4) === 4 && installDirectoryExists && depotsPresent,
    sizeOnDiskBytes: rawSize === null || rawSize < 0 ? null : rawSize,
    manifestLastPlayedAt: positiveOrNull(getVdfNumber(state, "lastplayed")),
    lastUpdatedAt: positiveOrNull(getVdfNumber(state, "lastupdated")),
    libraryPath,
  };
}

function readManifests(
  libraries: ResolvedLibrary[],
  warnings: LocalScanWarning[],
): { manifests: LocalManifest[]; complete: boolean } {
  const manifests: LocalManifest[] = [];
  let complete = true;

  for (const library of libraries) {
    if (!library.readable) {
      complete = false;
      continue;
    }
    const steamapps = join(library.realPath, "steamapps");
    let names: string[];
    try {
      names = readdirSync(steamapps);
    } catch (error) {
      complete = false;
      warn(
        warnings,
        "library_unreadable",
        `Could not read ${steamapps}: ${(error as Error).message}`,
        steamapps,
      );
      continue;
    }

    for (const name of names.sort()) {
      const match = MANIFEST_PATTERN.exec(name);
      if (match === null) {
        continue;
      }
      const appId = Number.parseInt(match[1]!, 10);
      if (!Number.isSafeInteger(appId) || appId <= 0) {
        complete = false;
        warn(warnings, "manifest_invalid_appid", `${name} has an invalid App ID.`, steamapps);
        continue;
      }
      const filePath = join(steamapps, name);
      const text = readStable(filePath, warnings);
      if (text === null) {
        complete = false;
        continue;
      }
      const manifest = parseManifest(appId, filePath, library.realPath, text, warnings);
      if (manifest === null) {
        complete = false;
        continue;
      }
      manifests.push(manifest);
    }
  }

  manifests.sort((left, right) => left.appId - right.appId);
  return { manifests, complete };
}

function deriveAccountId(steamId64: string): string | null {
  try {
    const value = BigInt(steamId64) - 76_561_197_960_265_728n;
    return value >= 0n ? value.toString() : null;
  } catch {
    return null;
  }
}

function findAccountDirectory(
  root: string,
  steamId64: string | null,
): { accountId: string | null; directory: string | null } {
  if (steamId64 === null || !/^\d{17}$/.test(steamId64)) {
    return { accountId: null, directory: null };
  }
  const accountId = deriveAccountId(steamId64);
  const candidates = [accountId, steamId64].filter(
    (candidate): candidate is string => candidate !== null,
  );

  for (const candidate of new Set(candidates)) {
    const directory = join(root, "userdata", candidate);
    const localConfig = join(directory, "config", "localconfig.vdf");
    const cloudStorage = join(directory, "config", "cloudstorage");
    if (isFile(localConfig) || isDirectory(cloudStorage)) {
      return { accountId, directory };
    }
  }

  return { accountId, directory: null };
}

function navigate(node: VdfObject, keys: string[]): VdfObject | undefined {
  let current: VdfObject | undefined = node;
  for (const key of keys) {
    if (current === undefined) {
      return undefined;
    }
    current = getVdfObject(current, key);
  }
  return current;
}

function parseLocalConfig(
  text: string,
  filePath: string,
  warnings: LocalScanWarning[],
): { entries: LocalPlaytimeEntry[]; negativePlaytimeCount: number } | null {
  const root = parseVdfSafe(text, "userlocalconfigstore", filePath, warnings);
  if (root === null) {
    return null;
  }

  // A valid localconfig with no Software/Valve/Steam chain is an empty Apps
  // block, not an unreadable file.
  const steam = navigate(root, ["Software", "Valve", "Steam"]) ?? {};
  const apps = getVdfObject(steam, "apps") ?? {};

  const entries: LocalPlaytimeEntry[] = [];
  let negativePlaytimeCount = 0;

  const minutes = (value: number | null, field: string, appId: number): number | null => {
    if (value === null) {
      return null;
    }
    if (value < 0) {
      negativePlaytimeCount += 1;
      warn(
        warnings,
        "negative_playtime",
        `App ${appId} has a negative ${field}; clamped to 0.`,
        filePath,
      );
      return 0;
    }
    return value;
  };

  for (const [key, value] of Object.entries(apps)) {
    if (!DIGITS.test(key) || typeof value !== "object") {
      continue;
    }
    const appId = Number.parseInt(key, 10);
    if (!Number.isSafeInteger(appId) || appId <= 0) {
      continue;
    }
    entries.push({
      appId,
      playtimeMinutes: minutes(getVdfNumber(value, "playtime"), "Playtime", appId),
      playtime2weeksMinutes: minutes(getVdfNumber(value, "playtime2wks"), "Playtime2wks", appId),
      lastPlayedAt: positiveOrNull(getVdfNumber(value, "lastplayed")),
    });
  }

  entries.sort((left, right) => left.appId - right.appId);
  return { entries, negativePlaytimeCount };
}

function readLocalConfigEvidence(
  root: string,
  steamId64: string | null,
  warnings: LocalScanWarning[],
): {
  entries: LocalPlaytimeEntry[] | null;
  complete: boolean;
  negativePlaytimeCount: number;
  accountId: string | null;
  accountDir: string | null;
} {
  const { accountId, directory } = findAccountDirectory(root, steamId64);
  if (directory === null) {
    if (steamId64 !== null) {
      warn(
        warnings,
        "userdata_missing",
        "No userdata directory was found for the selected Steam Account.",
        join(root, "userdata"),
      );
    }
    return {
      entries: null,
      complete: false,
      negativePlaytimeCount: 0,
      accountId,
      accountDir: null,
    };
  }

  const filePath = join(directory, "config", "localconfig.vdf");
  const text = readStable(filePath, warnings);
  if (text === null) {
    return {
      entries: null,
      complete: false,
      negativePlaytimeCount: 0,
      accountId,
      accountDir: directory,
    };
  }
  const parsed = parseLocalConfig(text, filePath, warnings);
  return {
    entries: parsed?.entries ?? null,
    complete: parsed !== null,
    negativePlaytimeCount: parsed?.negativePlaytimeCount ?? 0,
    accountId,
    accountDir: directory,
  };
}

export function readSteamLocalLibrary(options: ReadSteamLocalOptions): LocalLibrarySnapshot {
  const warnings: LocalScanWarning[] = [];
  const root = resolve(options.steamRoot);

  if (!isDirectory(root) || !isDirectory(join(root, "steamapps"))) {
    warn(warnings, "steam_root_not_found", `Steam was not found at ${root}.`, root);
    return {
      root,
      found: false,
      libraries: [],
      manifests: [],
      localConfigEntries: null,
      accountId: null,
      accountDir: null,
      manifestsComplete: false,
      localConfigComplete: false,
      negativePlaytimeCount: 0,
      warnings,
    };
  }

  const discovery = discoverLibraries(root, warnings);
  const manifestRead = readManifests(discovery.libraries, warnings);
  const local = readLocalConfigEvidence(root, options.steamId64, warnings);

  return {
    root,
    found: true,
    libraries: discovery.libraries.map((library) => ({
      path: library.path,
      realPath: library.realPath,
      readable: library.readable,
    })),
    manifests: manifestRead.manifests,
    localConfigEntries: local.entries,
    accountId: local.accountId,
    accountDir: local.accountDir,
    manifestsComplete: discovery.complete && manifestRead.complete,
    localConfigComplete: local.complete,
    negativePlaytimeCount: local.negativePlaytimeCount,
    warnings,
  };
}
