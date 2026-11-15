import type { GameSummary } from "../../shared/types.ts";
import { useBrowse } from "../browse-context.tsx";
import { GameCard } from "./GameCard.tsx";
import { GameTable } from "./GameTable.tsx";

export interface GameResultsProps {
  games: GameSummary[];
}

/** The one grid/table switch shared by the Library and Steam Collection views. */
export function GameResults({ games }: GameResultsProps) {
  const { layout, isSelected, toggleSelected } = useBrowse();

  if (layout === "table") {
    return <GameTable games={games} />;
  }

  return (
    <div className="game-grid">
      {games.map((game) => (
        <GameCard
          key={game.appId}
          game={game}
          selected={isSelected(game.appId)}
          onToggleSelected={toggleSelected}
        />
      ))}
    </div>
  );
}
