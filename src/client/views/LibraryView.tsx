import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Code,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { ApiError, gamesQueryOptions, startLibraryScan } from "../api.ts";
import { useBrowse } from "../browse-context.tsx";
import { GameResults } from "../components/GameResults.tsx";
import { OwnershipBanner } from "../components/OwnershipBanner.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { ResultsHeader } from "../components/ResultsHeader.tsx";
import { SelectionBar } from "../components/SelectionBar.tsx";
import { useToast } from "../components/ToastProvider.tsx";
import { formatTimestamp } from "../format.ts";
import type { ShellContext } from "../shell-context.ts";

export interface LibraryViewProps {
  mode: "all" | "installed";
}

const PAGE_SIZE = 60;

function LoadingGrid() {
  const reduceMotion = useReducedMotion();

  return (
    <Box component="section" aria-busy="true" aria-label="Loading the Library">
      <Box className="skeleton-grid">
        {Array.from({ length: 8 }, (_, index) => (
          <Paper className="skeleton-card" key={index} p="sm" radius="md" withBorder>
            <Skeleton
              className="skeleton-cover"
              height={100}
              radius="sm"
              animate={!reduceMotion}
              mb="sm"
            />
            <Skeleton className="skeleton-line" height={10} radius="xl" animate={!reduceMotion} />
            <Skeleton
              className="skeleton-line short"
              height={10}
              radius="xl"
              width="55%"
              mt={7}
              animate={!reduceMotion}
            />
          </Paper>
        ))}
      </Box>
    </Box>
  );
}

export function LibraryView({ mode }: LibraryViewProps) {
  const { status, error: statusError, reloadStatus } = useOutletContext<ShellContext>();
  const { showToast } = useToast();
  const {
    search,
    clearSearch,
    sort,
    order,
    installedOnly,
    layout,
    selectedCount,
    isSelected,
    selectShown,
    clearSelection,
  } = useBrowse();
  const [page, setPage] = useState(1);
  const [scanning, setScanning] = useState(false);
  const scanMutation = useMutation({ mutationFn: startLibraryScan });

  const installedFilter = mode === "installed" || installedOnly;

  const gamesQuery = useQuery(
    gamesQueryOptions({
      page,
      pageSize: PAGE_SIZE,
      sort,
      order,
      ...(search.trim() === "" ? {} : { search }),
      ...(installedFilter ? { installed: true } : {}),
    }),
  );
  const games = gamesQuery.data ?? null;
  const error = gamesQuery.error === null ? null : (gamesQuery.error as Error).message;

  useEffect(() => {
    setPage(1);
  }, [search, sort, order, installedFilter, layout, mode]);

  // A finished Refresh changes the stored rows; refetch without making the
  // initial status load look like a finished run.
  const finishedAt = status?.lastRefresh?.finishedAt ?? null;
  const previousFinishedAt = useRef<string | null>(null);
  useEffect(() => {
    if (previousFinishedAt.current !== null && previousFinishedAt.current !== finishedAt) {
      void gamesQuery.refetch();
    }
    previousFinishedAt.current = finishedAt;
  }, [finishedAt, gamesQuery.refetch]);

  const scan = async (): Promise<void> => {
    setScanning(true);
    try {
      const run = await scanMutation.mutateAsync();
      if (run.status === "failed") {
        showToast(run.error?.message ?? "The scan failed.");
      } else if (run.status === "partial") {
        showToast("Scan finished with some Steam data unavailable.");
      } else {
        showToast("Library scan finished.");
      }
      setPage(1);
      if (page === 1) {
        await gamesQuery.refetch();
      }
      reloadStatus();
    } catch (scanError) {
      showToast(
        scanError instanceof ApiError ? scanError.message : "The Library scan could not start.",
      );
    } finally {
      setScanning(false);
    }
  };

  if (status === null) {
    // AppShell already shows the disconnected banner when the status fetch fails.
    return statusError === null ? <LoadingGrid /> : null;
  }

  if (games === null && error === null) {
    return <LoadingGrid />;
  }

  const steamRoot = status.steam.root;
  const steamMissing = status.steam.state === "not_found";
  const noAccount = status.steam.state === "no_account";
  const totalItems = games?.pagination.totalItems ?? 0;
  const totalPages = games?.pagination.totalPages ?? 0;
  const dataAsOf = games?.meta.dataAsOf ?? null;
  const rows = games?.data ?? [];
  const filtered = search.trim() !== "" || installedFilter;
  const allShownSelected = rows.length > 0 && rows.every((game) => isSelected(game.appId));

  const actions = (
    <Group gap="sm" wrap="wrap">
      <Button onClick={() => void scan()} disabled={scanning}>
        {scanning ? "Scanning…" : "Scan again"}
      </Button>
      <Button component={Link} to="/onboarding" variant="default">
        Change Steam folder
      </Button>
    </Group>
  );

  if (steamMissing && rows.length === 0 && search.trim() === "") {
    return (
      <Paper
        component="section"
        className="empty-library"
        maw={640}
        mx="auto"
        my="xl"
        aria-labelledby="steam-missing-heading"
        p="lg"
        radius="lg"
        withBorder
      >
        <Stack gap="sm">
          <Title order={2} id="steam-missing-heading">
            Steam was not found.
          </Title>
          <Text c="gray.5">
            Install or start Steam, then scan again. A moved library, a Flatpak install, or a fresh
            Steam install can all leave the Library empty.
          </Text>
          {steamRoot !== null && (
            <Text size="sm">
              Configured Steam folder: <Code>{steamRoot}</Code>
            </Text>
          )}
          {actions}
        </Stack>
      </Paper>
    );
  }

  if (error !== null && games === null) {
    return <DisconnectedBanner message={error} onRetry={() => void gamesQuery.refetch()} />;
  }

  const banners = (
    <>
      {error !== null && (
        <DisconnectedBanner message={error} onRetry={() => void gamesQuery.refetch()} />
      )}
      {noAccount && <NoAccountBanner />}
      {status !== null && <OwnershipBanner status={status} />}
    </>
  );

  if (rows.length === 0) {
    if (search.trim() !== "") {
      return (
        <Box component="section" aria-label="Search results">
          <Stack gap="md">
            {banners}
            {selectedCount > 0 && <SelectionBar />}
            <Paper
              component="section"
              className="empty-library"
              maw={640}
              mx="auto"
              my="xl"
              role="status"
              aria-labelledby="no-results-heading"
              p="lg"
              radius="lg"
              withBorder
            >
              <Stack gap="sm">
                <Title order={2} id="no-results-heading">
                  No games match &quot;{search}&quot;.
                </Title>
                <Text c="gray.5">
                  Search looks at game names only. Tags, genres, and playtime belong in Rules.
                </Text>
                <Group gap="sm" wrap="wrap">
                  <Button variant="default" onClick={clearSearch}>
                    Clear search
                  </Button>
                </Group>
              </Stack>
            </Paper>
          </Stack>
        </Box>
      );
    }

    const heading = mode === "installed" ? "No installed games found." : "No games found.";
    return (
      <Box component="section" aria-label={mode === "installed" ? "Installed games" : "All games"}>
        <Stack gap="md">
          {banners}
          {selectedCount > 0 && <SelectionBar />}
          <Paper
            component="section"
            className="empty-library"
            maw={640}
            mx="auto"
            my="xl"
            aria-labelledby="empty-heading"
            p="lg"
            radius="lg"
            withBorder
          >
            <Stack gap="sm">
              <Title order={2} id="empty-heading">
                {heading}
              </Title>
              <Text c="gray.5">
                {mode === "installed"
                  ? "No app manifest reports an installed Game yet. Nothing has been moved or deleted."
                  : "Nothing has been scanned yet, or Steam has no local Games for this Account. A moved Steam library, a Flatpak install, or a fresh Steam install can all leave this list empty."}
              </Text>
              {steamRoot !== null && (
                <Text size="sm">
                  Steam root: <Code>{steamRoot}</Code>
                </Text>
              )}
              {actions}
            </Stack>
          </Paper>
        </Stack>
      </Box>
    );
  }

  return (
    <Box component="section" aria-label={mode === "installed" ? "Installed games" : "All games"}>
      <Stack gap="md">
        {banners}
        <SelectionBar />
        <ResultsHeader
          totalItems={totalItems}
          shownItems={rows.length}
          filtered={filtered}
          allShownSelected={allShownSelected}
          hasGames={rows.length > 0}
          selectionCount={selectedCount}
          onSelectShown={() => selectShown(rows.map((game) => game.appId))}
          onClearSelection={clearSelection}
        />
        <GameResults games={rows} />
        {totalItems > 0 && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            totalItems={totalItems}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        )}
        {dataAsOf !== null && (
          <Text component="footer" className="results-footer" size="xs">
            Data as of <time dateTime={dataAsOf}>{formatTimestamp(dataAsOf)}</time>
          </Text>
        )}
      </Stack>
    </Box>
  );
}

function DisconnectedBanner({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <Alert
      className="banner banner-error"
      color="red"
      variant="light"
      role="alert"
      title="Cannot reach game-cat. Is the server still running?"
    >
      <Group gap="sm" wrap="wrap" justify="space-between">
        <Text size="sm">{message}</Text>
        <Button variant="default" onClick={onRetry}>
          Retry connection
        </Button>
      </Group>
    </Alert>
  );
}

function NoAccountBanner() {
  return (
    <Alert
      className="banner banner-warning"
      color="yellow"
      variant="light"
      role="status"
      title="No Steam Account selected."
    >
      <Group gap="sm" wrap="wrap" justify="space-between">
        <Text size="sm">
          The Library still shows local data, but playtime and Steam Collections are unavailable
          until an Account is selected.
        </Text>
        <Button component={Link} to="/onboarding" variant="default">
          Open account picker
        </Button>
      </Group>
    </Alert>
  );
}
