import { Link, useLocation } from "react-router-dom";
import type { GameSummary } from "../../shared/types.ts";
import {
  formatPlaytime,
  ownershipLabel,
  reviewCardLabel,
  reviewPillLabel,
  reviewTone,
} from "../format.ts";
import { GameCover } from "./GameCover.tsx";

export interface GameCardProps {
  game: GameSummary;
  selected: boolean;
  onToggleSelected(appId: number): void;
}

function ownershipFlag(game: GameSummary): string | null {
  if (game.ownershipStatus === "owned") {
    return null;
  }
  return ownershipLabel(game.ownershipStatus);
}

export function GameCard({ game, selected, onToggleSelected }: GameCardProps) {
  const location = useLocation();
  const flag = ownershipFlag(game);
  const review = reviewPillLabel(game.reviewScore);
  const reviewLabel = reviewCardLabel(game.reviewTier, game.reviewCount);
  const tags = game.tags.slice(0, 2).map((tag) => tag.name);

  return (
    <article
      className={`game-card${selected ? " is-selected" : ""}`}
      data-selected={selected ? "true" : "false"}
    >
      <Link
        className="card-open"
        to={{ pathname: `/games/${game.appId}`, search: location.search }}
        state={{ backgroundLocation: location }}
      >
        <div className="game-cover-wrap">
          <GameCover appId={game.appId} name={game.name} />
          <div className="card-pills">
            {game.installed === true ? (
              <span className="pill pill-installed">
                <span className="status-dot" aria-hidden="true" />
                Installed
              </span>
            ) : game.installed === null ? (
              <span className="pill pill-installed is-unknown">Unknown</span>
            ) : (
              <span />
            )}
            {review !== null && (
              <span
                className={`review-pill ${reviewTone(game.reviewScore)}`}
                title={game.reviewTier ?? undefined}
              >
                {review}
              </span>
            )}
          </div>
        </div>
        <div className="game-card-body">
          <h3 className="game-name" title={game.name}>
            {game.name}
          </h3>
          <p className="game-meta">
            <span>{formatPlaytime(game.playtimeMinutes)}</span>
            {flag !== null && <span className="ownership-flag">{flag}</span>}
          </p>
          <p className={`game-review review-text ${reviewTone(game.reviewScore)}`}>{reviewLabel}</p>
          <p className="game-tags">{tags.length > 0 ? tags.join(" · ") : "No tags yet"}</p>
          <span
            className={`tag-status is-${game.metadata.tagsStatus}`}
            title={`Tags: ${game.metadata.tagsStatus}`}
          >
            Tags: {game.metadata.tagsStatus}
          </span>
        </div>
      </Link>
      <label className="select-check">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelected(game.appId)}
          aria-label={`Select ${game.name}`}
        />
      </label>
    </article>
  );
}
