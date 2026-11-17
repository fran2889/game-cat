import { Checkbox, Table, Text, UnstyledButton } from "@mantine/core";
import { Link, useLocation } from "react-router-dom";
import type { GameSummary } from "../../../shared/types.ts";
import type { TableSortField } from "../../browse.ts";
import { useBrowse } from "../../browse-context.tsx";
import {
  formatDate,
  formatPlaytime,
  ownershipLabel,
  reviewSummaryLabel,
  reviewTone,
} from "../../format.ts";
import { GameCover } from "../GameCover.tsx";

export interface LibraryTableProps {
  games: GameSummary[];
}

function selectAllState(games: GameSummary[], isSelected: (appId: number) => boolean) {
  const selectedCount = games.filter((game) => isSelected(game.appId)).length;
  return {
    all: games.length > 0 && selectedCount === games.length,
    some: selectedCount > 0 && selectedCount < games.length,
  };
}

/**
 * Library-only Mantine table. The shared GameTable stays untouched for the
 * Steam Collection and Smart Collection previews until they are converted.
 */
export function LibraryTable({ games }: LibraryTableProps) {
  const location = useLocation();
  const { sort, order, applyTableSort, isSelected, toggleSelected, selectShown, clearShown } =
    useBrowse();
  const state = selectAllState(games, isSelected);

  const sortableHeader = (label: string, field: TableSortField) => {
    const active = sort === field;
    const ariaSort = active ? (order === "asc" ? "ascending" : "descending") : "none";
    return (
      <Table.Th scope="col" aria-sort={ariaSort} key={field}>
        <UnstyledButton
          className="th-sort"
          onClick={() => applyTableSort(field)}
          aria-label={`Sort by ${label}${active ? (order === "asc" ? " descending" : " ascending") : ""}`}
        >
          {label}
          {active && (
            <span className={`th-arrow${order === "desc" ? " is-desc" : ""}`} aria-hidden="true">
              ↑
            </span>
          )}
        </UnstyledButton>
      </Table.Th>
    );
  };

  const toggleAll = () => {
    const ids = games.map((game) => game.appId);
    if (state.all) {
      clearShown(ids);
    } else {
      selectShown(ids);
    }
  };

  return (
    <div className="table-wrap">
      <Table className="game-table" verticalSpacing={7} horizontalSpacing={10}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col" className="col-check">
              <Checkbox
                size="md"
                styles={{ input: { width: 24, height: 24 } }}
                checked={state.all}
                indeterminate={state.some}
                onChange={toggleAll}
                aria-label="Select all shown games"
              />
            </Table.Th>
            {sortableHeader("Game", "name")}
            <Table.Th scope="col">Installed</Table.Th>
            {sortableHeader("Playtime", "playtime")}
            {sortableHeader("Last played", "lastPlayed")}
            <Table.Th scope="col">Review</Table.Th>
            {sortableHeader("Released", "releaseYear")}
            <Table.Th scope="col">Tags</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {games.map((game) => {
            const selected = isSelected(game.appId);
            const review = reviewSummaryLabel(game.reviewScore, game.reviewTier, game.reviewCount);
            const tags = game.tags.slice(0, 3).map((tag) => tag.name);
            return (
              <Table.Tr key={game.appId} className={selected ? "is-selected" : undefined}>
                <Table.Td>
                  <Checkbox
                    size="md"
                    styles={{ input: { width: 24, height: 24 } }}
                    checked={selected}
                    onChange={() => toggleSelected(game.appId)}
                    aria-label={`Select ${game.name}`}
                  />
                </Table.Td>
                <Table.Td>
                  <Link
                    className="table-game"
                    to={{ pathname: `/games/${game.appId}`, search: location.search }}
                    state={{ backgroundLocation: location }}
                  >
                    <GameCover appId={game.appId} name={game.name} className="table-thumb" />
                    <span>
                      <span className="table-game-name">{game.name}</span>
                      {game.ownershipStatus !== "owned" && (
                        <span className="table-game-sub">
                          {ownershipLabel(game.ownershipStatus)}
                        </span>
                      )}
                    </span>
                  </Link>
                </Table.Td>
                <Table.Td>
                  {game.installed === true ? "Yes" : game.installed === false ? "No" : "—"}
                </Table.Td>
                <Table.Td className="mono">{formatPlaytime(game.playtimeMinutes)}</Table.Td>
                <Table.Td>{formatDate(game.lastPlayedAt)}</Table.Td>
                <Table.Td className={`review-text ${reviewTone(game.reviewScore)}`}>
                  {review}
                </Table.Td>
                <Table.Td className="mono">{game.releaseYear ?? "—"}</Table.Td>
                <Table.Td>
                  {tags.length > 0 ? tags.join(", ") : "—"}
                  <Text
                    component="span"
                    className={`tag-status is-${game.metadata.tagsStatus}`}
                    title={`Tags: ${game.metadata.tagsStatus}`}
                  >
                    {" "}
                    {game.metadata.tagsStatus}
                  </Text>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </div>
  );
}
