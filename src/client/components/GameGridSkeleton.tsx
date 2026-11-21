import { Box, Card, Skeleton, Stack } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";

export interface GameGridSkeletonProps {
  /** The busy region's accessible name, e.g. "Loading the Library". */
  label: string;
  count?: number;
}

/**
 * The loading grid shared by the Library, Steam Collection, Smart Collection
 * route, and the editor preview. It uses the same tracks as GameResults and
 * repeats the card shell, so the settled grid replaces it without a layout
 * shift.
 */
export function GameGridSkeleton({ label, count = 60 }: GameGridSkeletonProps) {
  const reduceMotion = useReducedMotion();

  return (
    <Box component="section" aria-busy="true" aria-label={label}>
      <Box className="skeleton-grid">
        {Array.from({ length: count }, (_, index) => (
          <Card key={index} className="skeleton-card" padding={0} radius="md" withBorder>
            <Box className="game-cover-wrap">
              <Skeleton
                className="skeleton-cover"
                height="100%"
                radius={0}
                animate={!reduceMotion}
              />
            </Box>
            <Stack className="card-body" gap={4}>
              <Skeleton height={12} radius="xl" width="72%" animate={!reduceMotion} />
              <Skeleton height={11} radius="xl" width="48%" animate={!reduceMotion} />
              <Skeleton height={10} radius="xl" width="60%" animate={!reduceMotion} />
            </Stack>
          </Card>
        ))}
      </Box>
    </Box>
  );
}
