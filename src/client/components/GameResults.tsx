import { Box } from "@mantine/core";
import type { GameSummary } from "../../shared/types.ts";
import { useBrowse } from "../browse-context.tsx";
import { GameCard } from "./GameCard.tsx";
import { GameTable } from "./GameTable.tsx";

export interface GameResultsProps {
  games: GameSummary[];
  /** The editor preview is always grid; the Library and Steam views use the stored layout. */
  forceGrid?: boolean;
}

/** The one grid/table switch shared by the Library, Steam Collection, and editor preview. */
export function GameResults({ games, forceGrid = false }: GameResultsProps) {
  const { layout: storedLayout, isSelected, toggleSelected } = useBrowse();
  const layout = forceGrid ? "grid" : storedLayout;

  if (layout === "table") {
    return <GameTable games={games} />;
  }

  return (
    <Box className="game-grid">
      {games.map((game) => (
        <GameCard
          key={game.appId}
          game={game}
          selected={isSelected(game.appId)}
          onToggleSelected={toggleSelected}
        />
      ))}
    </Box>
  );
}
