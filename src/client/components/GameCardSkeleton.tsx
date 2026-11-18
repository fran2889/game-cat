import { Box, Card, Skeleton, Stack } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";

/**
 * The grid loading placeholder shared by the Library, Steam Collection, and
 * editor preview.
 *
 * It mirrors GameCard's shell exactly: a flush 2/3 portrait cover and a body
 * box with the same reserved height and padding. The grid therefore keeps its
 * layout when the real cards arrive.
 */
export function GameCardSkeleton() {
  const reduceMotion = useReducedMotion();

  return (
    <Card className="skeleton-card" padding={0} radius="md" withBorder>
      <Box className="game-cover-wrap">
        <Skeleton className="skeleton-cover" height="100%" radius={0} animate={!reduceMotion} />
      </Box>
      <Stack className="card-body" gap={4}>
        <Skeleton height={12} radius="xl" width="72%" animate={!reduceMotion} />
        <Skeleton height={11} radius="xl" width="48%" animate={!reduceMotion} />
        <Skeleton height={10} radius="xl" width="60%" animate={!reduceMotion} />
      </Stack>
    </Card>
  );
}
