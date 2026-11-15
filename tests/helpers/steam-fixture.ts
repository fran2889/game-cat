import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const TEST_STEAM_ID64 = "76561198000000000";
export const TEST_ACCOUNT_ID = "39734272";

export interface ManifestOptions {
  name?: string | null;
  stateFlags?: number | string;
  installDir?: string | null;
  createdInstallDir?: boolean;
  sizeOnDisk?: number | string | null;
  lastPlayed?: number | string | null;
  lastUpdated?: number | string | null;
  depots?: Record<string, unknown> | null;
  appidOverride?: number | string | null;
}

export interface LocalConfigApp {
  playtime?: number | string | null;
  playtime2wks?: number | string | null;
  lastPlayed?: number | string | null;
}

export interface CloudStorageEntry {
  key: string;
  /** The cloud-storage `value` field. Already a JSON string in real files. */
  value?: unknown;
  isDeleted?: boolean;
  timestamp?: number;
  version?: string;
}

export interface WriteCloudStorageOptions {
  overlay?: boolean;
  accountId?: string;
}

function q(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** A synthetic, disposable Steam tree. Tests never touch a real install. */
export class SteamFixture {
  readonly base: string;
  readonly root: string;
  readonly libraries: string[] = [];

  constructor() {
    this.base = mkdtempSync(join(tmpdir(), "game-cat-steam-"));
    this.root = join(this.base, "Steam");
    mkdirSync(join(this.root, "steamapps"), { recursive: true });
    mkdirSync(join(this.root, "config"), { recursive: true });
    this.libraries.push(this.root);
  }

  /** Create a second library directory and register it in libraryfolders.vdf. */
  addLibrary(name = "Library2", options: { legacy?: boolean; listed?: boolean } = {}): string {
    const library = join(this.base, name);
    mkdirSync(join(library, "steamapps"), { recursive: true });
    this.libraries.push(library);
    if (options.listed !== false) {
      this.writeLibraryFolders(options.legacy === true);
    }
    return library;
  }

  writeLibraryFolders(legacy = false): void {
    const entries = this.libraries
      .map((library, index) => {
        if (legacy) {
          return `  ${q(String(index))} ${q(library)}`;
        }
        return `  ${q(String(index))} { "path" ${q(library)} "apps" { } }`;
      })
      .join("\n");
    writeFileSync(
      join(this.root, "config", "libraryfolders.vdf"),
      `"libraryfolders"\n{\n${entries}\n}\n`,
    );
  }

  writeRawLibraryFolders(content: string, legacyLocation = false): void {
    const path = legacyLocation
      ? join(this.root, "steamapps", "libraryfolders.vdf")
      : join(this.root, "config", "libraryfolders.vdf");
    writeFileSync(path, content);
  }

  installDir(library: string, installDir: string): string {
    const path = join(library, "steamapps", "common", installDir);
    mkdirSync(path, { recursive: true });
    return path;
  }

  writeManifest(library: string, appId: number, options: ManifestOptions = {}): string {
    const installDir = options.installDir === undefined ? `App ${appId}` : options.installDir;
    if (installDir !== null && options.createdInstallDir !== false) {
      this.installDir(library, installDir);
    }
    const depots =
      options.depots === undefined
        ? `"InstalledDepots" { "${appId + 1}" { "manifest" "1" "size" "8" } }`
        : options.depots === null
          ? ""
          : `"InstalledDepots" { ${Object.entries(options.depots)
              .map(([key, value]) => `"${key}" { "manifest" "${String(value)}" "size" "8" }`)
              .join(" ")} }`;
    const name =
      options.name === null ? "" : `  "name" ${q(options.name ?? `Fixture Game ${appId}`)}`;
    const fields = [
      `  "appid" ${q(String(options.appidOverride ?? appId))}`,
      name,
      `  "StateFlags" ${q(String(options.stateFlags ?? 4))}`,
      ...(installDir === null ? [] : [`  "installdir" ${q(installDir)}`]),
      ...(options.lastUpdated === null
        ? []
        : [`  "LastUpdated" ${q(String(options.lastUpdated ?? 1712000000))}`]),
      ...(options.lastPlayed === null
        ? []
        : [`  "LastPlayed" ${q(String(options.lastPlayed ?? 1712100000))}`]),
      ...(options.sizeOnDisk === null
        ? []
        : [`  "SizeOnDisk" ${q(String(options.sizeOnDisk ?? 13200000000))}`]),
      `  ${depots}`,
    ].filter((line) => line.trim() !== "");

    const path = join(library, "steamapps", `appmanifest_${appId}.acf`);
    writeFileSync(path, `"AppState"\n{\n${fields.join("\n")}\n}\n`);
    return path;
  }

  writeLocalConfig(
    apps: Record<string, LocalConfigApp>,
    accountId: string = TEST_ACCOUNT_ID,
  ): string {
    const blocks = Object.entries(apps)
      .map(([appId, app]) => {
        const fields = [
          ...(app.lastPlayed === undefined || app.lastPlayed === null
            ? []
            : [`"LastPlayed" ${q(String(app.lastPlayed))}`]),
          ...(app.playtime === undefined || app.playtime === null
            ? []
            : [`"Playtime" ${q(String(app.playtime))}`]),
          ...(app.playtime2wks === undefined || app.playtime2wks === null
            ? []
            : [`"Playtime2wks" ${q(String(app.playtime2wks))}`]),
        ];
        return `"${appId}" { ${fields.join(" ")} }`;
      })
      .join("\n");

    const path = join(this.root, "userdata", accountId, "config", "localconfig.vdf");
    mkdirSync(join(this.root, "userdata", accountId, "config"), { recursive: true });
    writeFileSync(
      path,
      `"UserLocalConfigStore"\n{\n  "Software" { "Valve" { "Steam"\n  {\n    "apps"\n    {\n${blocks}\n    }\n  } } }\n}\n`,
    );
    return path;
  }

  writeRawLocalConfig(content: string, accountId: string = TEST_ACCOUNT_ID): string {
    const path = join(this.root, "userdata", accountId, "config", "localconfig.vdf");
    mkdirSync(join(this.root, "userdata", accountId, "config"), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  writeLoginUsers(steamId64 = TEST_STEAM_ID64, personaName = "Player One"): string {
    const path = join(this.root, "config", "loginusers.vdf");
    writeFileSync(
      path,
      `"users"\n{\n  "${steamId64}"\n  {\n    "AccountName" "account-under-test"\n    "PersonaName" ${q(
        personaName,
      )}\n    "MostRecent" "1"\n    "Timestamp" "1663423107"\n  }\n}\n`,
    );
    return path;
  }

  cloudStoragePath(overlay = false, accountId: string = TEST_ACCOUNT_ID): string {
    return join(
      this.root,
      "userdata",
      accountId,
      "config",
      "cloudstorage",
      overlay ? "cloud-storage-namespace-1.modified.json" : "cloud-storage-namespace-1.json",
    );
  }

  /** Write the cloud-storage array-of-pairs shape used by Steam Collections. */
  writeCloudStorage(entries: CloudStorageEntry[], options: WriteCloudStorageOptions = {}): string {
    const pairs = entries.map((entry) => {
      const body: Record<string, unknown> = {
        key: entry.key,
        timestamp: entry.timestamp ?? 1,
        version: entry.version ?? "1",
      };
      if (entry.value !== undefined) {
        body.value = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      }
      if (entry.isDeleted === true) {
        body.is_deleted = true;
      }
      return [entry.key, body];
    });
    return this.writeRawCloudStorage(JSON.stringify(pairs), options);
  }

  writeRawCloudStorage(content: string, options: WriteCloudStorageOptions = {}): string {
    const path = this.cloudStoragePath(options.overlay === true, options.accountId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  /** A second path that resolves to the same directory, for de-duplication. */
  addSymlink(name = "SteamLink"): string {
    const link = join(this.base, name);
    symlinkSync(realpathSync(this.root), link, "dir");
    return link;
  }

  dispose(): void {
    rmSync(this.base, { recursive: true, force: true });
  }
}
