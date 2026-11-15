import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router-dom";
import type { GameOrder, GameSort, ViewKind } from "../shared/types.ts";
import {
  nextTableSort,
  readLayout,
  writeLayout,
  type Layout,
  type TableSortField,
} from "./browse.ts";

interface BrowseContextValue {
  viewKind: ViewKind;
  layout: Layout;
  setLayout(layout: Layout): void;
  search: string;
  setSearch(search: string): void;
  clearSearch(): void;
  sort: GameSort;
  order: GameOrder;
  setSort(sort: GameSort): void;
  setOrder(order: GameOrder): void;
  toggleOrder(): void;
  applyTableSort(field: TableSortField): void;
  installedOnly: boolean;
  setInstalledOnly(value: boolean): void;
  selectedIds: number[];
  selectedCount: number;
  isSelected(appId: number): boolean;
  toggleSelected(appId: number): void;
  selectShown(appIds: number[]): void;
  clearShown(appIds: number[]): void;
  clearSelection(): void;
}

const BrowseContext = createContext<BrowseContextValue | null>(null);

type SelectionMap = Record<ViewKind, ReadonlySet<number>>;

function emptySelections(): SelectionMap {
  return {
    library: new Set<number>(),
    installed: new Set<number>(),
    smart: new Set<number>(),
    steam: new Set<number>(),
  };
}

function initialLayouts(): Record<ViewKind, Layout> {
  return {
    library: readLayout("library"),
    installed: readLayout("installed"),
    smart: readLayout("smart"),
    steam: readLayout("steam"),
  };
}

export interface BrowseProviderProps {
  viewKind: ViewKind;
  children: ReactNode;
}

/**
 * Browse state shared by the shell toolbar and every Library-like view.
 *
 * Layout is a per-view client preference in localStorage; selection is a
 * per-view in-memory set for this session. Search maps to `?q=` so reload,
 * deep links, and browser history all agree with the visible list.
 */
export function BrowseProvider({ viewKind, children }: BrowseProviderProps): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const [layouts, setLayouts] = useState<Record<ViewKind, Layout>>(initialLayouts);
  const [sort, setSortState] = useState<GameSort>("name");
  const [order, setOrder] = useState<GameOrder>("asc");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [selections, setSelections] = useState<SelectionMap>(emptySelections);

  const search = searchParams.get("q") ?? "";

  const setSearch = useCallback(
    (value: string) => {
      const next = new URLSearchParams(searchParams);
      if (value.trim() === "") {
        next.delete("q");
      } else {
        next.set("q", value);
      }
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const clearSearch = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("q");
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const setLayout = useCallback(
    (layout: Layout) => {
      setLayouts((current) => ({ ...current, [viewKind]: layout }));
      writeLayout(viewKind, layout);
    },
    [viewKind],
  );

  const setSort = useCallback((next: GameSort) => {
    setSortState(next);
  }, []);

  const toggleOrder = useCallback(() => {
    setOrder((current) => (current === "asc" ? "desc" : "asc"));
  }, []);

  const applyTableSort = useCallback(
    (field: TableSortField) => {
      const next = nextTableSort(sort, order, field);
      setSortState(next.sort);
      setOrder(next.order);
    },
    [order, sort],
  );

  const updateCurrentSelection = useCallback(
    (updater: (current: ReadonlySet<number>) => Set<number>) => {
      setSelections((current) => ({
        ...current,
        [viewKind]: updater(current[viewKind]),
      }));
    },
    [viewKind],
  );

  const toggleSelected = useCallback(
    (appId: number) => {
      updateCurrentSelection((current) => {
        const next = new Set(current);
        if (next.has(appId)) {
          next.delete(appId);
        } else {
          next.add(appId);
        }
        return next;
      });
    },
    [updateCurrentSelection],
  );

  const selectShown = useCallback(
    (appIds: number[]) => {
      updateCurrentSelection((current) => {
        const next = new Set(current);
        for (const appId of appIds) {
          next.add(appId);
        }
        return next;
      });
    },
    [updateCurrentSelection],
  );

  const clearShown = useCallback(
    (appIds: number[]) => {
      updateCurrentSelection((current) => {
        const next = new Set(current);
        for (const appId of appIds) {
          next.delete(appId);
        }
        return next;
      });
    },
    [updateCurrentSelection],
  );

  const clearSelection = useCallback(() => {
    updateCurrentSelection(() => new Set<number>());
  }, [updateCurrentSelection]);

  const currentSelection = selections[viewKind];
  const selectedIds = useMemo(
    () => [...currentSelection].sort((left, right) => left - right),
    [currentSelection],
  );

  const value = useMemo<BrowseContextValue>(
    () => ({
      viewKind,
      layout: layouts[viewKind],
      setLayout,
      search,
      setSearch,
      clearSearch,
      sort,
      order,
      setSort,
      setOrder,
      toggleOrder,
      applyTableSort,
      installedOnly,
      setInstalledOnly,
      selectedIds,
      selectedCount: selectedIds.length,
      isSelected: (appId: number) => currentSelection.has(appId),
      toggleSelected,
      selectShown,
      clearShown,
      clearSelection,
    }),
    [
      viewKind,
      layouts,
      setLayout,
      search,
      setSearch,
      clearSearch,
      sort,
      order,
      setSort,
      toggleOrder,
      applyTableSort,
      installedOnly,
      selectedIds,
      currentSelection,
      toggleSelected,
      selectShown,
      clearShown,
      clearSelection,
    ],
  );

  return <BrowseContext.Provider value={value}>{children}</BrowseContext.Provider>;
}

export function useBrowse(): BrowseContextValue {
  const value = useContext(BrowseContext);
  if (value === null) {
    throw new Error("useBrowse must be used inside BrowseProvider");
  }
  return value;
}
