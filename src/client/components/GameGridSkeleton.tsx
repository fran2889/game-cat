import { Box } from "@mantine/core";
import { GameCardSkeleton } from "./GameCardSkeleton.tsx";

export interface GameGridSkeletonProps {
  /** The busy region's accessible name, e.g. "Loading the Library". */
  label: string;
  count?: number;
}

/**
 * The loading grid shared by the Library, Steam Collection, and the Smart
 * Collection editor route. It uses the same tracks as GameResults and repeats
 * the card shell, so the settled grid replaces it without a layout shift.
 */
export function GameGridSkeleton({ label, count = 12 }: GameGridSkeletonProps) {
  return (
    <Box component="section" aria-busy="true" aria-label={label}>
      <Box className="skeleton-grid">
        {Array.from({ length: count }, (_, index) => (
          <GameCardSkeleton key={index} />
        ))}
      </Box>
    </Box>
  );
}
