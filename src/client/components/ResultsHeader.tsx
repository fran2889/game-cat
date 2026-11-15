import { formatCount } from "../format.ts";

export interface ResultsHeaderProps {
  totalItems: number;
  shownItems: number;
  filtered: boolean;
  allShownSelected: boolean;
  hasGames: boolean;
  selectionCount: number;
  onSelectShown(): void;
  onClearSelection(): void;
}

export function ResultsHeader({
  totalItems,
  shownItems,
  filtered,
  allShownSelected,
  hasGames,
  selectionCount,
  onSelectShown,
  onClearSelection,
}: ResultsHeaderProps) {
  const label = filtered
    ? `${formatCount(totalItems)} total · ${formatCount(shownItems)} shown`
    : `${formatCount(totalItems)} ${totalItems === 1 ? "game" : "games"}`;

  return (
    <div className="results-head">
      <span className="results-count" aria-live="polite">
        {label}
      </span>
      <div className="results-actions">
        {hasGames && (
          <button
            type="button"
            className="button button-small"
            onClick={onSelectShown}
            disabled={allShownSelected}
          >
            {allShownSelected ? "All shown selected" : "Select shown"}
          </button>
        )}
        {selectionCount > 0 && (
          <button type="button" className="button button-small" onClick={onClearSelection}>
            Clear selection
          </button>
        )}
      </div>
    </div>
  );
}
