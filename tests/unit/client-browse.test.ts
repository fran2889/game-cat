import { describe, expect, it } from "vitest";
import {
  LAYOUT_STORAGE_PREFIX,
  canCreateFromSelection,
  canRefreshSelection,
  formatRange,
  layoutStorageKey,
  nextTableSort,
  parseLayout,
  readLayout,
  selectionLimitMessages,
  viewKindForPath,
  writeLayout,
  type LayoutStorage,
} from "../../src/client/browse.ts";

class MemoryStorage implements LayoutStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("layout persistence", () => {
  it("defaults to grid and accepts only the documented layout values", () => {
    expect(parseLayout(null)).toBe("grid");
    expect(parseLayout("grid")).toBe("grid");
    expect(parseLayout("table")).toBe("table");
    expect(parseLayout("masonry")).toBe("grid");
    expect(parseLayout("")).toBe("grid");
  });

  it("persists the layout per view kind under game-cat.layout.v1.<viewKind>", () => {
    const storage = new MemoryStorage();
    expect(layoutStorageKey("library")).toBe(`${LAYOUT_STORAGE_PREFIX}library`);
    expect(readLayout("library", storage)).toBe("grid");

    writeLayout("library", "table", storage);
    writeLayout("steam", "table", storage);

    expect(storage.values.get("game-cat.layout.v1.library")).toBe("table");
    expect(storage.values.get("game-cat.layout.v1.steam")).toBe("table");
    expect(readLayout("library", storage)).toBe("table");
    expect(readLayout("installed", storage)).toBe("grid");
  });

  it("falls back to grid when storage is unavailable or stale", () => {
    const broken: LayoutStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(readLayout("library", broken)).toBe("grid");
    expect(() => writeLayout("library", "table", broken)).not.toThrow();

    const storage = new MemoryStorage();
    storage.setItem("game-cat.layout.v1.library", "stale-value");
    expect(readLayout("library", storage)).toBe("grid");
  });
});

describe("view kind routing", () => {
  it("maps each documented route to its view kind", () => {
    expect(viewKindForPath("/")).toBe("library");
    expect(viewKindForPath("/installed")).toBe("installed");
    expect(viewKindForPath("/smart/new")).toBe("smart");
    expect(viewKindForPath("/smart/abc")).toBe("smart");
    expect(viewKindForPath("/steam/favorite")).toBe("steam");
    expect(viewKindForPath("/games/620")).toBe("library");
  });
});

describe("table sorting", () => {
  it("toggles the active column and starts a new column ascending", () => {
    expect(nextTableSort("name", "asc", "name")).toEqual({ sort: "name", order: "desc" });
    expect(nextTableSort("name", "desc", "name")).toEqual({ sort: "name", order: "asc" });
    expect(nextTableSort("name", "desc", "playtime")).toEqual({
      sort: "playtime",
      order: "asc",
    });
  });
});

describe("page range copy", () => {
  it("shows the current slice and total", () => {
    expect(formatRange(1, 60, 130)).toBe("1–60 of 130");
    expect(formatRange(2, 60, 130)).toBe("61–120 of 130");
    expect(formatRange(3, 60, 130)).toBe("121–130 of 130");
    expect(formatRange(1, 60, 0)).toBe("0 of 0");
  });
});

describe("selection limits", () => {
  it("allows New from selection for 1-1,000 Games", () => {
    expect(canCreateFromSelection(0)).toBe(false);
    expect(canCreateFromSelection(1)).toBe(true);
    expect(canCreateFromSelection(1_000)).toBe(true);
    expect(canCreateFromSelection(1_001)).toBe(false);
  });

  it("allows Refresh selected up to 5,000 Games", () => {
    expect(canRefreshSelection(0)).toBe(false);
    expect(canRefreshSelection(1)).toBe(true);
    expect(canRefreshSelection(5_000)).toBe(true);
    expect(canRefreshSelection(5_001)).toBe(false);
  });

  it("explains the empty, 1,000, and 5,000 limits", () => {
    expect(selectionLimitMessages(0)).toEqual([
      "Select at least one game to create a Smart Collection.",
    ]);
    expect(selectionLimitMessages(1_001)).toEqual([
      "New from selection supports up to 1,000 Games.",
    ]);
    expect(selectionLimitMessages(5_001)).toEqual([
      "New from selection supports up to 1,000 Games.",
      "Refresh selected supports up to 5,000 Games.",
    ]);
    expect(selectionLimitMessages(10)).toEqual([]);
  });
});
