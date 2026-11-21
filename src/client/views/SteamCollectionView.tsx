import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Alert, Badge, Box, Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import type { SteamCollectionSummary } from "../../shared/types.ts";
import { ApiError, steamCollectionGamesQueryOptions, steamCollectionQueryOptions } from "../api.ts";
import { useBrowse } from "../browse-context.tsx";
import { GameResults } from "../components/GameResults.tsx";
import { LoadingGrid } from "../components/LoadingGrid.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { ResultsHeader } from "../components/ResultsHeader.tsx";
import { SelectionBar } from "../components/SelectionBar.tsx";
import { formatTimestamp } from "../format.ts";

const PAGE_SIZE = 60;

function kindLabel(kind: SteamCollectionSummary["kind"]): string {
  switch (kind) {
    case "favorite":
      return "Favorites";
    case "hidden":
      return "Hidden";
    case "user":
      return "User Collection";
    case "tag":
      return "Tag snapshot";
    case "system":
      return "Steam system Collection";
    default:
      return "Steam Collection";
  }
}

export function SteamCollectionView() {
  const { id = "" } = useParams();
  const { sort, order, layout, selectedCount, isSelected, selectShown, clearSelection } =
    useBrowse();
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [id]);

  useEffect(() => {
    setPage(1);
  }, [sort, order, layout]);

  const summaryQuery = useQuery({
    ...steamCollectionQueryOptions(id),
    enabled: id !== "",
  });
  const membersQuery = useQuery({
    ...steamCollectionGamesQueryOptions(id, { page, pageSize: PAGE_SIZE, sort, order }),
    enabled: id !== "",
  });

  const notFound = (error: Error | null): boolean =>
    error instanceof ApiError && error.status === 404;
  const missing = id === "" || notFound(summaryQuery.error) || notFound(membersQuery.error);
  const queryError = [summaryQuery.error, membersQuery.error].find(
    (error): error is Error => error !== null && !notFound(error),
  );
  const error = queryError?.message ?? null;
  const summary = summaryQuery.data ?? null;
  const members = membersQuery.data ?? null;

  if (missing) {
    return (
      <Paper
        component="section"
        aria-labelledby="steam-collection-missing"
        p="lg"
        radius="lg"
        withBorder
      >
        <Stack gap="sm">
          <Title order={2} id="steam-collection-missing">
            Steam Collection not found.
          </Title>
          <Text c="gray.5">
            It is not in the current Steam Collection mirror. It may have been deleted in Steam
            before the last scan.
          </Text>
          <Group gap="sm">
            <Button component={Link} to="/" variant="default">
              Back to the Library
            </Button>
          </Group>
        </Stack>
      </Paper>
    );
  }

  if (error !== null) {
    return (
      <Alert color="red" variant="light" role="alert" title="Cannot load this Steam Collection.">
        <Stack gap="sm" align="flex-start">
          <Text size="sm">{error}</Text>
          <Button
            variant="default"
            onClick={() => {
              void summaryQuery.refetch();
              void membersQuery.refetch();
            }}
          >
            Retry
          </Button>
        </Stack>
      </Alert>
    );
  }

  if (summary === null) {
    return <LoadingGrid label="Loading the Steam Collection" count={4} />;
  }

  const header = (
    <Box component="header" className="collection-header">
      <Stack gap={4}>
        <Text size="xs" c="gray.5" tt="uppercase" fw={700}>
          Steam collections
        </Text>
        <Title order={2} id="collection-heading">
          {summary.name}
        </Title>
        <Group className="collection-meta" gap="sm" wrap="wrap">
          <Badge variant="outline" tt="none" leftSection={<span aria-hidden="true">🔒</span>}>
            Read-only mirror · never written back
          </Badge>
          <Text component="span" size="xs" c="gray.5">
            {kindLabel(summary.kind)}
          </Text>
          {summary.isDynamic && (
            <Badge variant="light" tt="none">
              Dynamic
            </Badge>
          )}
        </Group>
      </Stack>
    </Box>
  );

  if (summary.isDynamic) {
    return (
      <Stack component="section" aria-labelledby="collection-heading" gap="md">
        {header}
        <Paper
          component="section"
          aria-labelledby="dynamic-collection-heading"
          p="lg"
          radius="md"
          withBorder
        >
          <Stack gap="sm">
            <Title order={2} id="dynamic-collection-heading">
              Steam computes this Collection
            </Title>
            <Text c="gray.5">
              Steam computes this Collection&apos;s membership. game-cat treats dynamic Collections
              as opaque metadata in v1.
            </Text>
            <Text c="gray.5">
              There is no stored member list and no game count, and this Collection never
              contributes matches to the steamCollection Rule Field.
            </Text>
          </Stack>
        </Paper>
      </Stack>
    );
  }

  const totalItems = members?.pagination.totalItems ?? summary.gameCount ?? 0;
  const totalPages = members?.pagination.totalPages ?? 0;
  const dataAsOf = members?.meta.dataAsOf ?? null;
  const rows = members?.data ?? [];
  const allShownSelected = rows.length > 0 && rows.every((game) => isSelected(game.appId));

  if (members === null) {
    return (
      <Stack component="section" aria-labelledby="collection-heading" gap="md">
        {header}
        <LoadingGrid label="Loading the Steam Collection" count={4} />
      </Stack>
    );
  }

  return (
    <Stack component="section" aria-labelledby="collection-heading" gap="md">
      {header}

      {totalItems === 0 ? (
        <>
          {selectedCount > 0 && <SelectionBar />}
          <Paper
            component="section"
            aria-labelledby="empty-collection-heading"
            p="lg"
            radius="lg"
            withBorder
          >
            <Stack gap="sm">
              <Title order={2} id="empty-collection-heading">
                This Steam Collection is empty
              </Title>
              <Text c="gray.5">Steam returned no static members for this Collection.</Text>
            </Stack>
          </Paper>
        </>
      ) : (
        <>
          <SelectionBar />
          <ResultsHeader
            totalItems={totalItems}
            shownItems={rows.length}
            filtered={false}
            allShownSelected={allShownSelected}
            hasGames={rows.length > 0}
            selectionCount={selectedCount}
            onSelectShown={() => selectShown(rows.map((game) => game.appId))}
            onClearSelection={clearSelection}
          />
          <GameResults games={rows} />
          {totalPages > 0 && (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              totalItems={totalItems}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          )}
          {dataAsOf !== null && (
            <Text component="footer" className="results-footer" size="xs" c="gray.5" ta="center">
              Data as of <time dateTime={dataAsOf}>{formatTimestamp(dataAsOf)}</time>
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}
