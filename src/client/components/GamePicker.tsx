import { useEffect, useState } from "react";
import type { GameSummary } from "../../shared/types.ts";
import { fetchGames } from "../api.ts";
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
  const [results, setResults] = useState<GameSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      fetchGames(
        {
          page: 1,
          pageSize: 60,
          sort: "name",
          order: "asc",
          ...(query.trim() === "" ? {} : { search: query.trim() }),
        },
        controller.signal,
      )
        .then((response) => {
          setResults(response.data);
          setLoading(false);
        })
        .catch((error: unknown) => {
          if ((error as Error).name !== "AbortError") {
            setResults([]);
            setLoading(false);
          }
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

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
    <div className="game-picker">
      <div className="game-picker-head">
        <button
          type="button"
          className="button button-small"
          aria-expanded={open}
          aria-controls={`${inputId}-list`}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide games" : `Choose games (${value.length})`}
        </button>
        <button
          type="button"
          className="button button-small"
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
        </button>
        <span className="game-picker-count">
          {value.length} {value.length === 1 ? "game" : "games"} in this rule
        </span>
      </div>

      {value.length > 0 && (
        <ul className="picker-chips" aria-label="Games in this Rule">
          {value.map((appId) => (
            <li key={appId} className="chip">
              <span>#{appId}</span>
              <button
                type="button"
                aria-label={`Remove game ${appId} from this Rule`}
                onClick={() => onChange(value.filter((id) => id !== appId))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="game-picker-list" id={`${inputId}-list`}>
          <label className="sr-only" htmlFor={`${inputId}-search`}>
            Search Games for this Rule
          </label>
          <input
            id={`${inputId}-search`}
            type="search"
            value={query}
            placeholder="Search game names"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
          {loading ? (
            <p className="picker-note" role="status">
              Searching…
            </p>
          ) : results.length === 0 ? (
            <p className="picker-note">No Games match that search.</p>
          ) : (
            <ul className="picker-results">
              {results.map((game) => (
                <li key={game.appId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(game.appId)}
                      onChange={() => toggle(game.appId)}
                    />
                    <span>{game.name}</span>
                    <span className="picker-id">#{game.appId}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
