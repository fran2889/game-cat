import { Button, Group, Text } from "@mantine/core";
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
    <Group className="results-head" gap="sm" wrap="wrap">
      <Text component="span" className="results-count" aria-live="polite" size="sm" c="gray.5">
        {label}
      </Text>
      <Group className="results-actions" gap="xs" ml="auto">
        {hasGames && (
          <Button
            size="compact-sm"
            variant="default"
            onClick={onSelectShown}
            disabled={allShownSelected}
          >
            {allShownSelected ? "All shown selected" : "Select shown"}
          </Button>
        )}
        {selectionCount > 0 && (
          <Button size="compact-sm" variant="default" onClick={onClearSelection}>
            Clear selection
          </Button>
        )}
      </Group>
    </Group>
  );
}
