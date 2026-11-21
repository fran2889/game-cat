import { Button } from "@mantine/core";

export interface SelectShownButtonProps {
  allShownSelected: boolean;
  onSelectShown(): void;
}

/**
 * The shared Select shown affordance: disabled once every shown Game is
 * selected, so the Library header and the Smart editor preview read the same.
 */
export function SelectShownButton({ allShownSelected, onSelectShown }: SelectShownButtonProps) {
  return (
    <Button size="compact-sm" variant="default" onClick={onSelectShown} disabled={allShownSelected}>
      {allShownSelected ? "All shown selected" : "Select shown"}
    </Button>
  );
}
