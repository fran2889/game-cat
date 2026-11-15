import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import type { GameSummary } from "../../shared/types.ts";
import type { TableSortField } from "../browse.ts";
import { useBrowse } from "../browse-context.tsx";
import {
  formatDate,
  formatPlaytime,
  ownershipLabel,
  reviewSummaryLabel,
  reviewTone,
} from "../format.ts";
import { GameCover } from "./GameCover.tsx";

export interface GameTableProps {
  games: GameSummary[];
}

function selectAllState(games: GameSummary[], isSelected: (appId: number) => boolean) {
  const selectedCount = games.filter((game) => isSelected(game.appId)).length;
  return {
    all: games.length > 0 && selectedCount === games.length,
    some: selectedCount > 0 && selectedCount < games.length,
  };
}

export function GameTable({ games }: GameTableProps) {
  const location = useLocation();
  const { sort, order, applyTableSort, isSelected, toggleSelected, selectShown, clearShown } =
    useBrowse();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const state = selectAllState(games, isSelected);

  useEffect(() => {
    if (selectAllRef.current !== null) {
      selectAllRef.current.indeterminate = state.some;
    }
  }, [state.some]);

  const sortableHeader = (label: string, field: TableSortField) => {
    const active = sort === field;
    const ariaSort = active ? (order === "asc" ? "ascending" : "descending") : "none";
    return (
      <th aria-sort={ariaSort} key={field}>
        <button
          type="button"
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
        </button>
      </th>
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
      <table className="game-table">
        <thead>
          <tr>
            <th className="col-check">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={state.all}
                onChange={toggleAll}
                aria-label="Select all shown games"
              />
            </th>
            {sortableHeader("Game", "name")}
            <th>Installed</th>
            {sortableHeader("Playtime", "playtime")}
            {sortableHeader("Last played", "lastPlayed")}
            <th>Review</th>
            {sortableHeader("Released", "releaseYear")}
            <th>Tags</th>
          </tr>
        </thead>
        <tbody>
          {games.map((game) => {
            const selected = isSelected(game.appId);
            const review = reviewSummaryLabel(game.reviewScore, game.reviewTier, game.reviewCount);
            const tags = game.tags.slice(0, 3).map((tag) => tag.name);
            return (
              <tr key={game.appId} className={selected ? "is-selected" : undefined}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleSelected(game.appId)}
                    aria-label={`Select ${game.name}`}
                  />
                </td>
                <td>
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
                </td>
                <td>{game.installed === true ? "Yes" : game.installed === false ? "No" : "—"}</td>
                <td className="mono">{formatPlaytime(game.playtimeMinutes)}</td>
                <td>{formatDate(game.lastPlayedAt)}</td>
                <td className={`review-text ${reviewTone(game.reviewScore)}`}>{review}</td>
                <td className="mono">{game.releaseYear ?? "—"}</td>
                <td>{tags.length > 0 ? tags.join(", ") : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
