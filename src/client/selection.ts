import type { GameSummary } from "../shared/types.ts";

export interface ShownSelection {
  /** True when every shown Game is selected; false for an empty page. */
  all: boolean;
  /** True when some, but not all, shown Games are selected. */
  some: boolean;
  /** The shown App IDs, in display order. */
  appIds: number[];
}

/** One select-all state for the grid, table, and results header affordances. */
export function shownSelection(
  games: readonly GameSummary[],
  isSelected: (appId: number) => boolean,
): ShownSelection {
  const appIds = games.map((game) => game.appId);
  const selected = appIds.filter((appId) => isSelected(appId)).length;
  return {
    all: appIds.length > 0 && selected === appIds.length,
    some: selected > 0 && selected < appIds.length,
    appIds,
  };
}
