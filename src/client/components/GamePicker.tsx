import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, Button, Checkbox, Group, Pill, Stack, Text, TextInput } from "@mantine/core";
import type { GameSummary } from "../../shared/types.ts";
import { gamesQueryOptions } from "../api.ts";
import { sortedGameIds } from "../rule-editor.ts";

export interface GamePickerProps {
  /** The App IDs currently in the Rule value. */
  value: number[];
  onChange(appIds: number[]): void;
  /** The current view selection, offered through Use selection. */
  selectedIds: number[];
  inputId: string;
}

const MAX_GAME_IDS = 1_000;

/** Search, checkboxes, chips, and Use selection for the `game in [...]` Rule. */
export function GamePicker({ value, onChange, selectedIds, inputId }: GamePickerProps) {
  const [open, setOpen] = useState(value.length === 0);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const gamesQuery = useQuery({
    ...gamesQueryOptions({
      page: 1,
      pageSize: 60,
      sort: "name",
      order: "asc",
      ...(debouncedQuery.trim() === "" ? {} : { search: debouncedQuery.trim() }),
    }),
    enabled: open,
  });
  const results: GameSummary[] = gamesQuery.isError ? [] : (gamesQuery.data?.data ?? []);
  const loading = open && gamesQuery.isFetching;

  const selected = new Set(value);
  const toggle = (appId: number): void => {
    const next = new Set(value);
    if (next.has(appId)) {
      next.delete(appId);
    } else if (next.size < MAX_GAME_IDS) {
      next.add(appId);
    }
    onChange(sortedGameIds(next));
  };

  const useSelection = (): void => {
    onChange(sortedGameIds(selectedIds));
  };

  return (
    <Stack className="game-picker" gap={6}>
      <Group className="game-picker-head" gap={6} wrap="wrap">
        <Button
          type="button"
          size="compact-sm"
          variant="default"
          aria-expanded={open}
          aria-controls={`${inputId}-list`}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide games" : `Choose games (${value.length})`}
        </Button>
        <Button
          type="button"
          size="compact-sm"
          variant="default"
          onClick={useSelection}
          disabled={selectedIds.length === 0 || selectedIds.length > MAX_GAME_IDS}
          title={
            selectedIds.length === 0
              ? "Select Games in the results pane first."
              : selectedIds.length > MAX_GAME_IDS
                ? `A Game Rule supports up to ${MAX_GAME_IDS} Games.`
                : undefined
          }
        >
          Use selection ({selectedIds.length})
        </Button>
        <Text component="span" className="game-picker-count" size="xs" c="gray.5">
          {value.length} {value.length === 1 ? "game" : "games"} in this rule
        </Text>
      </Group>

      {value.length > 0 && (
        <Pill.Group className="picker-chips" aria-label="Games in this Rule" gap={4}>
          {value.map((appId) => (
            <Pill
              key={appId}
              className="chip"
              withRemoveButton
              onRemove={() => onChange(value.filter((id) => id !== appId))}
              removeButtonProps={{ "aria-label": `Remove game ${appId} from this Rule` }}
            >
              #{appId}
            </Pill>
          ))}
        </Pill.Group>
      )}

      {open && (
        <Stack className="game-picker-list" id={`${inputId}-list`} gap={6} p="xs">
          <TextInput
            id={`${inputId}-search`}
            type="search"
            value={query}
            placeholder="Search game names"
            aria-label="Search Games for this Rule"
            autoComplete="off"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {loading ? (
            <Text className="picker-note" size="xs" c="gray.5" role="status">
              Searching…
            </Text>
          ) : results.length === 0 ? (
            <Text className="picker-note" size="xs" c="gray.5">
              No Games match that search.
            </Text>
          ) : (
            <Box
              component="ul"
              className="picker-results"
              style={{ listStyle: "none", padding: 0, margin: 0 }}
            >
              {results.map((game) => (
                <Box component="li" key={game.appId}>
                  <Checkbox
                    size="md"
                    styles={{ input: { width: 24, height: 24 } }}
                    checked={selected.has(game.appId)}
                    onChange={() => toggle(game.appId)}
                    label={
                      <Group gap="xs" wrap="nowrap">
                        <Text component="span" size="sm" className="picker-name">
                          {game.name}
                        </Text>
                        <Text component="span" className="picker-id" size="xs" c="gray.5">
                          #{game.appId}
                        </Text>
                      </Group>
                    }
                  />
                </Box>
              ))}
            </Box>
          )}
        </Stack>
      )}
    </Stack>
  );
}
