import type { GameOrder, GameSort, ViewKind } from "../shared/types.ts";

export const LAYOUT_STORAGE_PREFIX = "game-cat.layout.v1.";

export type Layout = "grid" | "table";

/** The minimum storage surface needed, so the layout helpers stay testable. */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const VIEW_KINDS: readonly ViewKind[] = ["library", "installed", "smart", "steam"];

export function layoutStorageKey(viewKind: ViewKind): string {
  return `${LAYOUT_STORAGE_PREFIX}${viewKind}`;
}

export function parseLayout(value: string | null): Layout {
  return value === "table" ? "table" : "grid";
}

function browserStorage(): LayoutStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLayout(
  viewKind: ViewKind,
  storage: LayoutStorage | null = browserStorage(),
): Layout {
  if (storage === null) {
    return "grid";
  }
  try {
    return parseLayout(storage.getItem(layoutStorageKey(viewKind)));
  } catch {
    return "grid";
  }
}

export function writeLayout(
  viewKind: ViewKind,
  layout: Layout,
  storage: LayoutStorage | null = browserStorage(),
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(layoutStorageKey(viewKind), layout);
  } catch {
    // A blocked localStorage is a client preference problem, never a page failure.
  }
}

export function viewKindForPath(pathname: string): ViewKind {
  if (pathname === "/installed") {
    return "installed";
  }
  if (pathname === "/smart" || pathname.startsWith("/smart/")) {
    return "smart";
  }
  if (pathname.startsWith("/steam/")) {
    return "steam";
  }
  return "library";
}

export const TABLE_SORT_FIELDS = ["name", "playtime", "lastPlayed", "releaseYear"] as const;
export type TableSortField = (typeof TABLE_SORT_FIELDS)[number];

export function nextTableSort(
  currentSort: GameSort,
  currentOrder: GameOrder,
  field: TableSortField,
): { sort: GameSort; order: GameOrder } {
  if (currentSort === field) {
    return { sort: field, order: currentOrder === "asc" ? "desc" : "asc" };
  }
  return { sort: field, order: "asc" };
}

export function formatRange(page: number, pageSize: number, totalItems: number): string {
  if (totalItems <= 0) {
    return "0 of 0";
  }
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);
  return `${start}–${end} of ${totalItems}`;
}

export const MAX_SELECTION_FOR_NEW = 1_000;
export const MAX_SELECTION_FOR_REFRESH = 5_000;

export function canCreateFromSelection(count: number): boolean {
  return count >= 1 && count <= MAX_SELECTION_FOR_NEW;
}

export function canRefreshSelection(count: number): boolean {
  return count >= 1 && count <= MAX_SELECTION_FOR_REFRESH;
}

/** The exact explanations shown next to disabled selection actions (§7.3). */
export function selectionLimitMessages(count: number): string[] {
  const messages: string[] = [];
  if (count === 0) {
    messages.push("Select at least one game to create a Smart Collection.");
  }
  if (count > MAX_SELECTION_FOR_NEW) {
    messages.push(
      `New from selection supports up to ${new Intl.NumberFormat("en-US").format(
        MAX_SELECTION_FOR_NEW,
      )} Games.`,
    );
  }
  if (count > MAX_SELECTION_FOR_REFRESH) {
    messages.push(
      `Refresh selected supports up to ${new Intl.NumberFormat("en-US").format(
        MAX_SELECTION_FOR_REFRESH,
      )} Games.`,
    );
  }
  return messages;
}

export const GAME_SORT_OPTIONS: ReadonlyArray<{ value: GameSort; label: string }> = [
  { value: "name", label: "Name" },
  { value: "playtime", label: "Playtime" },
  { value: "lastPlayed", label: "Last played" },
  { value: "releaseYear", label: "Release year" },
  { value: "metacritic", label: "Metacritic" },
  { value: "appId", label: "App ID" },
];
