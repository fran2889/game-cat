import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate, useOutletContext } from "react-router-dom";
import { Badge, Box, Button, DataList, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { METADATA_SOURCE_NAMES, SOURCE_ORDER, type SourceHealth } from "../../shared/types.ts";
import { useBrowse } from "../browse-context.tsx";
import { formatCount, formatTimestamp } from "../format.ts";
import { useRefresh } from "../refresh-context.tsx";
import {
  fetchAffectedAndPendingGames,
  isMetadataSource,
  sourceLabel,
  sourceStatusTone,
  type AffectedAndPendingGames,
  type MetadataSource,
} from "../refresh.ts";
import { defineQuery } from "../query-client.ts";
import type { ShellContext } from "../shell-context.ts";

const METADATA_SOURCES: readonly MetadataSource[] = METADATA_SOURCE_NAMES;

type AffectedState = Record<MetadataSource, AffectedAndPendingGames | null>;

function emptyAffected(): AffectedState {
  return Object.fromEntries(METADATA_SOURCE_NAMES.map((name) => [name, null])) as AffectedState;
}

const TONE_COLOR: Record<string, string> = {
  ok: "green",
  warning: "yellow",
  error: "red",
};

/**
 * `/errors` — one row per source in the documented order (§1.7, §7.7).
 *
 * Affected counts and IDs come from the documented `/api/games` status filters;
 * pending counts combine `missing` with no `*_fetched_at`. The view never
 * renders per-Game error text or upstream payloads; only the safe per-source
 * `lastError` crosses this surface.
 */
export function ErrorsView() {
  const { status } = useOutletContext<ShellContext>();
  const { isRunning, startFetch } = useRefresh();
  const { replaceSelection } = useBrowse();
  const navigate = useNavigate();
  const [selecting, setSelecting] = useState<MetadataSource | null>(null);

  const metadataKey = status === null ? "none" : JSON.stringify(status.metadata);
  const affectedQueries = useQueries({
    queries: METADATA_SOURCES.map((source) => ({
      ...defineQuery(["affected-and-pending", source, metadataKey] as const, (signal) =>
        fetchAffectedAndPendingGames(source, signal),
      ),
      enabled: status !== null,
    })),
  });
  const affected = emptyAffected();
  for (const [index, source] of METADATA_SOURCES.entries()) {
    const data = affectedQueries[index]?.data;
    if (data !== undefined) {
      affected[source] = data;
    }
  }
  const loadingAffected = status !== null && affectedQueries.some((query) => query.isPending);
  const affectedError = affectedQueries.some((query) => query.isError);

  const selectAffected = async (source: MetadataSource): Promise<void> => {
    const known = affected[source];
    if (known === null || known.affectedCount === 0) {
      return;
    }
    setSelecting(source);
    try {
      replaceSelection(known.affectedIds);
      navigate("/");
    } finally {
      setSelecting(null);
    }
  };

  if (status === null) {
    return (
      <Box component="section" className="errors-view">
        <Stack gap="md">
          <Title order={2} id="errors-heading">
            Refresh errors
          </Title>
          <Text>Cannot reach game-cat. Is the server still running?</Text>
        </Stack>
      </Box>
    );
  }

  const byName = new Map(status.sources.map((source) => [source.name, source]));
  const sources = SOURCE_ORDER.map((name) => byName.get(name)).filter(
    (source): source is SourceHealth => source !== undefined,
  );

  return (
    <Stack component="section" className="errors-view" aria-labelledby="errors-heading" gap="md">
      <Group
        className="errors-head"
        justify="space-between"
        align="flex-start"
        gap="md"
        wrap="wrap"
      >
        <Stack gap={4}>
          <Title order={2} id="errors-heading">
            Refresh errors
          </Title>
          <Text c="gray.5" size="sm">
            Per-source health for the five Refresh sources. Affected Games have a failed last
            attempt; pending Games have not been attempted yet. The Library stays usable with cached
            data while a source recovers.
          </Text>
        </Stack>
        <Button onClick={() => void startFetch()} disabled={isRunning}>
          Fetch
        </Button>
      </Group>

      <Stack
        component="ul"
        className="errors-list"
        gap="sm"
        style={{ listStyle: "none", padding: 0, margin: 0 }}
      >
        {sources.map((source) => {
          const tone = sourceStatusTone(source.status);
          const metadataName = isMetadataSource(source.name) ? source.name : null;
          const metadata = metadataName !== null;
          const affectedEntry = metadataName === null ? null : affected[metadataName];
          const count = affectedEntry === null ? null : affectedEntry.affectedCount;
          const pendingCount = affectedEntry?.pendingCount ?? 0;
          const canSelect =
            metadataName !== null &&
            affectedEntry !== null &&
            affectedEntry.affectedCount > 0 &&
            !loadingAffected &&
            !affectedError;
          return (
            <Paper
              component="li"
              key={source.name}
              className={`error-row tone-${tone}`}
              data-source={source.name}
              p="sm"
              radius="md"
              withBorder
            >
              <Group align="flex-start" gap="md" wrap="wrap">
                <Stack className="error-source" gap={6} style={{ flex: "1 1 150px", minWidth: 0 }}>
                  <Text fw={700}>{sourceLabel(source)}</Text>
                  <Badge
                    className={`status-pill tone-${tone}`}
                    color={TONE_COLOR[tone] ?? "gray"}
                    variant="light"
                    size="sm"
                    radius="xl"
                    tt="uppercase"
                  >
                    {source.status}
                  </Badge>
                </Stack>

                <DataList
                  className="error-times"
                  orientation="vertical"
                  gap={4}
                  style={{ flex: "1 1 190px" }}
                >
                  <DataList.Item>
                    <DataList.ItemLabel c="gray.5">Last success</DataList.ItemLabel>
                    <DataList.ItemValue>{formatTimestamp(source.lastSuccessAt)}</DataList.ItemValue>
                  </DataList.Item>
                  <DataList.Item>
                    <DataList.ItemLabel c="gray.5">Last attempt</DataList.ItemLabel>
                    <DataList.ItemValue>{formatTimestamp(source.lastAttemptAt)}</DataList.ItemValue>
                  </DataList.Item>
                  {source.retryAfterAt !== null && (
                    <DataList.Item>
                      <DataList.ItemLabel c="gray.5">Retry after</DataList.ItemLabel>
                      <DataList.ItemValue>
                        {formatTimestamp(source.retryAfterAt)}
                      </DataList.ItemValue>
                    </DataList.Item>
                  )}
                </DataList>

                <Stack className="error-detail" gap={4} style={{ flex: "1 1 180px", minWidth: 0 }}>
                  <Text className="error-message" size="sm" c="gray.5">
                    {source.lastError ?? "No recent error."}
                  </Text>
                  {metadata && (
                    <Text className="affected-count" size="xs" c="gray.5">
                      {loadingAffected
                        ? "Counting affected Games…"
                        : affectedError
                          ? "Affected Games could not be counted."
                          : `${formatCount(count ?? 0)} affected ${
                              count === 1 ? "Game" : "Games"
                            } · ${formatCount(pendingCount)} pending`}
                    </Text>
                  )}
                </Stack>

                {metadata && (
                  <Group className="error-actions" gap="xs" wrap="wrap">
                    <Button
                      variant="default"
                      size="compact-sm"
                      onClick={() => void startFetch()}
                      disabled={isRunning}
                    >
                      Fetch now
                    </Button>
                    <Button
                      variant="default"
                      size="compact-sm"
                      onClick={() => metadataName !== null && void selectAffected(metadataName)}
                      disabled={!canSelect || selecting !== null}
                      title={
                        !canSelect && !loadingAffected && !affectedError
                          ? "No affected Games for this source."
                          : undefined
                      }
                    >
                      Select affected
                    </Button>
                  </Group>
                )}
              </Group>
            </Paper>
          );
        })}
      </Stack>
    </Stack>
  );
}
