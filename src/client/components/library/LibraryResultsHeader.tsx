import { Button, Group, Text } from "@mantine/core";
import { formatCount } from "../../format.ts";

export interface LibraryResultsHeaderProps {
  totalItems: number;
  shownItems: number;
  filtered: boolean;
  allShownSelected: boolean;
  hasGames: boolean;
  selectionCount: number;
  onSelectShown(): void;
  onClearSelection(): void;
}

/** Library-only Mantine results header. */
export function LibraryResultsHeader({
  totalItems,
  shownItems,
  filtered,
  allShownSelected,
  hasGames,
  selectionCount,
  onSelectShown,
  onClearSelection,
}: LibraryResultsHeaderProps) {
  const label = filtered
    ? `${formatCount(totalItems)} total · ${formatCount(shownItems)} shown`
    : `${formatCount(totalItems)} ${totalItems === 1 ? "game" : "games"}`;

  return (
    <Group className="results-head" gap="sm">
      <Text component="span" className="results-count" aria-live="polite">
        {label}
      </Text>
      <Group className="results-actions" gap="xs" ml="auto">
        {hasGames && (
          <Button
            size="compact-xs"
            variant="default"
            onClick={onSelectShown}
            disabled={allShownSelected}
          >
            {allShownSelected ? "All shown selected" : "Select shown"}
          </Button>
        )}
        {selectionCount > 0 && (
          <Button size="compact-xs" variant="default" onClick={onClearSelection}>
            Clear selection
          </Button>
        )}
      </Group>
    </Group>
  );
}
