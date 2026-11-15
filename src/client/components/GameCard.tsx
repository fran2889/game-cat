import { useState } from "react";
import type { GameSummary } from "../../shared/types.ts";

const COVER_BASE = "https://cdn.akamai.steamstatic.com/steam/apps";

function coverUrl(appId: number): string {
  return `${COVER_BASE}/${appId}/header.jpg`;
}

function initials(name: string): string {
  const words = name
    .split(/[\s:–—-]+/)
    .map((word) => word.trim())
    .filter((word) => word !== "");
  if (words.length === 0) {
    return "?";
  }
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function formatPlaytime(minutes: number): string {
  if (minutes <= 0) {
    return "Not played";
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} m`;
}

function Cover({ game }: { game: GameSummary }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="game-cover game-cover-fallback" aria-hidden="true">
        {initials(game.name)}
      </div>
    );
  }
  return (
    <img
      className="game-cover"
      src={coverUrl(game.appId)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function GameCard({ game }: { game: GameSummary }) {
  const ownershipFlag =
    game.ownershipStatus === "local_only"
      ? "Local only"
      : game.ownershipStatus === "unknown"
        ? "Unknown ownership"
        : null;

  return (
    <article className="game-card">
      <div className="game-cover-wrap">
        <Cover game={game} />
        {game.installed === true && <span className="pill pill-installed">Installed</span>}
      </div>
      <div className="game-card-body">
        <h3 className="game-name" title={game.name}>
          {game.name}
        </h3>
        <p className="game-meta">
          <span>{formatPlaytime(game.playtimeMinutes)}</span>
          {ownershipFlag !== null && <span className="ownership-flag">{ownershipFlag}</span>}
        </p>
      </div>
    </article>
  );
}
