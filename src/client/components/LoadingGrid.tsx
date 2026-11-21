import { Box, Paper, Skeleton, Stack } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";

export interface LoadingGridProps {
  label: string;
  count?: number;
}

/**
 * Placeholder cards that mirror the flush portrait GameCard, so the grid does
 * not jump when the first page arrives.
 */
export function LoadingGrid({ label, count = 8 }: LoadingGridProps) {
  const reduceMotion = useReducedMotion();

  return (
    <Box component="section" aria-busy="true" aria-label={label}>
      <Box className="skeleton-grid">
        {Array.from({ length: count }, (_, index) => (
          <Paper className="skeleton-card" key={index} radius="md" withBorder>
            <Skeleton className="skeleton-cover" animate={!reduceMotion} />
            <Stack gap={4} p="sm">
              <Skeleton
                className="skeleton-line"
                height={14}
                width="70%"
                radius="xl"
                animate={!reduceMotion}
              />
              <Skeleton
                className="skeleton-line"
                height={10}
                width="45%"
                radius="xl"
                animate={!reduceMotion}
              />
              <Skeleton
                className="skeleton-line short"
                height={10}
                radius="xl"
                width="55%"
                animate={!reduceMotion}
              />
            </Stack>
          </Paper>
        ))}
      </Box>
    </Box>
  );
}
