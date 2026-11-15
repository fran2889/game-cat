import { readFileSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import type { SteamAccount, SteamState } from "../../shared/types.ts";
import { parseVdf, type VdfObject } from "./vdf.ts";

export interface DiscoverSteamOptions {
  /** Configured root. `null` asks discovery to look in the OS-standard places. */
  steamRoot: string | null;
  steamId64: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

export interface SteamDiscovery {
  root: string | null;
  state: SteamState;
  accounts: SteamAccount[];
  account: SteamAccount | null;
  /** A short, user-safe message. Never raw VDF text or AccountName. */
  error: string | null;
}

export type SteamDiscoveryFn = (options: DiscoverSteamOptions) => SteamDiscovery;

interface ParsedAccount {
  steamId64: string;
  personaName: string;
  timestamp: number;
  mostRecent: boolean;
}

/** OS-standard Steam root candidates, in the order v1 tries them. */
export function steamRootCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  if (platform === "win32") {
    const programFiles = env["ProgramFiles"]?.trim();
    const programFilesX86 = env["ProgramFiles(x86)"]?.trim();
    const localAppData = env.LOCALAPPDATA?.trim();
    return [
      ...(programFilesX86 === undefined || programFilesX86 === ""
        ? []
        : [join(programFilesX86, "Steam")]),
      ...(programFiles === undefined || programFiles === "" ? [] : [join(programFiles, "Steam")]),
      ...(localAppData === undefined || localAppData === "" ? [] : [join(localAppData, "Steam")]),
    ];
  }

  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", "Steam")];
  }

  const xdg = env.XDG_DATA_HOME?.trim();
  return [
    join(home, ".steam", "steam"),
    join(home, ".local", "share", "Steam"),
    ...(xdg === undefined || xdg === "" ? [] : [join(xdg, "Steam")]),
    join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
  ];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function deriveAccountId(steamId64: string): string {
  try {
    return (BigInt(steamId64) - 76_561_197_960_265_728n).toString();
  } catch {
    return "";
  }
}

function toAccount(account: ParsedAccount): SteamAccount {
  return {
    steamId64: account.steamId64,
    accountId: deriveAccountId(account.steamId64),
    // PersonaName is safe to show; AccountName is deliberately never read here.
    personaName: account.personaName === "" ? account.steamId64 : account.personaName,
  };
}

function parseLoginUsers(text: string): ParsedAccount[] {
  const document = parseVdf(text);
  const users = document.users;
  if (typeof users !== "object") {
    return [];
  }

  const accounts: ParsedAccount[] = [];
  for (const [steamId64, value] of Object.entries(users as VdfObject)) {
    if (!/^\d{17}$/.test(steamId64) || typeof value !== "object") {
      continue;
    }
    const fields = value as VdfObject;
    const personaName = typeof fields.PersonaName === "string" ? fields.PersonaName : "";
    const timestampValue =
      typeof fields.Timestamp === "string" ? Number.parseInt(fields.Timestamp, 10) : 0;
    accounts.push({
      steamId64,
      personaName,
      timestamp: Number.isFinite(timestampValue) ? timestampValue : 0,
      mostRecent: fields.MostRecent === "1",
    });
  }

  return accounts.sort((left, right) => left.steamId64.localeCompare(right.steamId64));
}

function selectAccount(
  accounts: ParsedAccount[],
  pinnedSteamId64: string | null,
): ParsedAccount | null {
  if (pinnedSteamId64 !== null) {
    return accounts.find((account) => account.steamId64 === pinnedSteamId64) ?? null;
  }
  if (accounts.length === 0) {
    return null;
  }

  const mostRecent = accounts.filter((account) => account.mostRecent);
  if (mostRecent.length === 1) {
    return mostRecent[0] ?? null;
  }

  // Ambiguous or absent MostRecent: newest Timestamp wins, with the stable
  // SteamID64 order as the final tiebreaker.
  let newest = accounts[0] ?? null;
  for (const account of accounts) {
    if (newest === null || account.timestamp > newest.timestamp) {
      newest = account;
    }
  }
  return newest;
}

/**
 * Read-only Steam discovery: root location and loginusers.vdf Accounts.
 *
 * App manifests, library folders, localconfig, and Steam Collections belong to
 * the local scan (#23), not this startup contract.
 */
export const discoverSteam: SteamDiscoveryFn = (options) => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? osHomedir();

  let root: string | null = null;
  if (options.steamRoot !== null) {
    // A configured root is authoritative: never silently fall back to another
    // Steam installation.
    root = options.steamRoot;
    if (!isDirectory(root)) {
      return { root, state: "not_found", accounts: [], account: null, error: null };
    }
  } else {
    root = steamRootCandidates(platform, env, home).find(isDirectory) ?? null;
    if (root === null) {
      return { root: null, state: "not_found", accounts: [], account: null, error: null };
    }
  }

  let text: string;
  try {
    text = readFileSync(join(root, "config", "loginusers.vdf"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { root, state: "no_account", accounts: [], account: null, error: null };
    }
    return {
      root,
      state: "error",
      accounts: [],
      account: null,
      error: `Could not read Steam accounts: ${(error as Error).message}`,
    };
  }

  let accounts: ParsedAccount[];
  try {
    accounts = parseLoginUsers(text);
  } catch (error) {
    return {
      root,
      state: "error",
      accounts: [],
      account: null,
      error: `Could not parse Steam accounts: ${(error as Error).message}`,
    };
  }

  const selected = selectAccount(accounts, options.steamId64);
  return {
    root,
    state: selected === null ? "no_account" : "ready",
    accounts: accounts.map(toAccount),
    account: selected === null ? null : toAccount(selected),
    error: null,
  };
};
