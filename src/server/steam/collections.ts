import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SteamCollectionKind } from "../../shared/types.ts";
import { readStable, type StableReadWarning } from "./read-stable.ts";

/**
 * Read-only reader for Steam Collections stored in Steam's cloud-storage JSON
 * (spec §2.4, §6.10 step 2/7). The base file and its `.modified` overlay are
 * merged by key before tombstones are dropped.
 */

export const COLLECTION_KEY_PREFIX = "user-collections.";
export const CLOUD_STORAGE_BASE = "cloud-storage-namespace-1.json";
export const CLOUD_STORAGE_OVERLAY = "cloud-storage-namespace-1.modified.json";

export type { SteamCollectionKind };

export interface SteamCollectionRecord {
  id: string;
  name: string;
  kind: SteamCollectionKind;
  isDynamic: boolean;
  filterSpecJson: string | null;
  rawValueJson: string;
  /** Static membership only; dynamic Collections keep this empty. */
  added: number[];
}

export interface SteamCollectionsSnapshot {
  /** `null` when the cloud-storage source could not be read completely. */
  collections: SteamCollectionRecord[] | null;
  complete: boolean;
}

interface CloudEntry {
  key?: unknown;
  value?: unknown;
  is_deleted?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectionKind(id: string): SteamCollectionKind {
  if (id === "favorite") {
    return "favorite";
  }
  if (id === "hidden") {
    return "hidden";
  }
  if (id.startsWith("uc-")) {
    return "user";
  }
  if (id.startsWith("from-tag-")) {
    return "tag";
  }
  if (id.startsWith("type-")) {
    return "system";
  }
  return "other";
}

function warn(warnings: StableReadWarning[], code: string, message: string, path?: string): void {
  warnings.push(path === undefined ? { code, message } : { code, message, path });
}

/** Parse the cloud-storage array-of-pairs shape. Returns null when malformed. */
export function parseCloudStorage(
  text: string,
  filePath: string,
  warnings: StableReadWarning[],
): Array<[string, CloudEntry]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warn(
      warnings,
      "cloud_storage_malformed",
      `Could not parse ${filePath}: ${(error as Error).message}`,
      filePath,
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    warn(
      warnings,
      "cloud_storage_malformed",
      `${filePath} is not the documented array of key/entry pairs.`,
      filePath,
    );
    return null;
  }

  const entries: Array<[string, CloudEntry]> = [];
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length < 2) {
      warn(
        warnings,
        "cloud_storage_entry_invalid",
        `${filePath} contains a malformed key/entry pair.`,
        filePath,
      );
      continue;
    }
    const entry = item[1];
    const key = typeof item[0] === "string" ? item[0] : isObject(entry) ? entry.key : undefined;
    if (typeof key !== "string" || key === "") {
      warn(
        warnings,
        "cloud_storage_entry_invalid",
        `${filePath} contains an entry without a key.`,
        filePath,
      );
      continue;
    }
    entries.push([key, isObject(entry) ? entry : {}]);
  }
  return entries;
}

function decodeValue(entry: CloudEntry): Record<string, unknown> | null {
  if (typeof entry.value !== "string") {
    return null;
  }
  let inner: unknown;
  try {
    inner = JSON.parse(entry.value);
    if (typeof inner === "string") {
      inner = JSON.parse(inner);
    }
  } catch {
    return null;
  }
  return isObject(inner) ? inner : null;
}

function parseAdded(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<number>();
  for (const candidate of value) {
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) {
      seen.add(candidate);
    }
  }
  return [...seen];
}

function recordFor(
  id: string,
  inner: Record<string, unknown>,
  warnings: StableReadWarning[],
  filePath: string,
): SteamCollectionRecord {
  const rawName = typeof inner.name === "string" ? inner.name.trim() : "";
  const name = rawName === "" ? id : rawName;

  const filterSpec = isObject(inner.filterSpec) ? inner.filterSpec : null;
  if (inner.filterSpec !== undefined && filterSpec === null) {
    warn(
      warnings,
      "collection_filter_spec_invalid",
      `Steam Collection ${id} has a non-object filterSpec; treating it as static.`,
      filePath,
    );
  }
  const isDynamic = filterSpec !== null && filterSpec.nFormatVersion === 2;
  if (filterSpec !== null && !isDynamic) {
    warn(
      warnings,
      "collection_filter_spec_unsupported",
      `Steam Collection ${id} has filterSpec version ${String(
        filterSpec.nFormatVersion,
      )}; treating it as static.`,
      filePath,
    );
  }

  return {
    id,
    name,
    kind: collectionKind(id),
    isDynamic,
    filterSpecJson: filterSpec === null ? null : JSON.stringify(filterSpec),
    rawValueJson: JSON.stringify(inner),
    added: isDynamic ? [] : parseAdded(inner.added),
  };
}

export interface ReadSteamCollectionsOptions {
  /** The selected Account's `userdata/<id>` directory, or null. */
  accountDir: string | null;
  warnings: StableReadWarning[];
}

/**
 * Read the base file and the `.modified` overlay when present, merge by key
 * (overlay wins), drop tombstones, and decode every `user-collections.*` value.
 */
export function readSteamCollections(
  options: ReadSteamCollectionsOptions,
): SteamCollectionsSnapshot {
  const { accountDir, warnings } = options;
  if (accountDir === null) {
    return { collections: null, complete: false };
  }

  const directory = join(accountDir, "config", "cloudstorage");
  const basePath = join(directory, CLOUD_STORAGE_BASE);
  const overlayPath = join(directory, CLOUD_STORAGE_OVERLAY);

  // A missing base file is a valid empty mirror; a base file that exists but
  // cannot be read or parsed is not.
  let baseEntries: Array<[string, CloudEntry]> = [];
  if (existsSync(basePath)) {
    const text = readStable(basePath, warnings);
    if (text === null) {
      return { collections: null, complete: false };
    }
    const parsed = parseCloudStorage(text, basePath, warnings);
    if (parsed === null) {
      return { collections: null, complete: false };
    }
    baseEntries = parsed;
  }

  let overlayEntries: Array<[string, CloudEntry]> = [];
  if (existsSync(overlayPath)) {
    const text = readStable(overlayPath, warnings);
    if (text === null) {
      return { collections: null, complete: false };
    }
    const parsed = parseCloudStorage(text, overlayPath, warnings);
    if (parsed === null) {
      return { collections: null, complete: false };
    }
    overlayEntries = parsed;
  }

  const merged = new Map<string, CloudEntry>();
  for (const [key, entry] of [...baseEntries, ...overlayEntries]) {
    merged.set(key, entry);
  }

  const collections: SteamCollectionRecord[] = [];
  for (const [key, entry] of merged) {
    if (!key.startsWith(COLLECTION_KEY_PREFIX)) {
      continue;
    }
    if (entry.is_deleted === true) {
      continue;
    }
    const id = key.slice(COLLECTION_KEY_PREFIX.length);
    if (id === "") {
      continue;
    }
    const inner = decodeValue(entry);
    if (inner === null) {
      warn(
        warnings,
        "collection_value_invalid",
        `Steam Collection ${id} has a value that is not a double-encoded JSON object.`,
        overlayPath,
      );
      continue;
    }
    collections.push(recordFor(id, inner, warnings, overlayPath));
  }

  collections.sort((left, right) => left.id.localeCompare(right.id));
  return { collections, complete: true };
}
