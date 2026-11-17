import { Badge, Box, Card, Checkbox, Stack, Text, Title } from "@mantine/core";
import { Link, useLocation } from "react-router-dom";
import type { GameSummary } from "../../../shared/types.ts";
import {
  formatPlaytime,
  ownershipLabel,
  reviewCardLabel,
  reviewPillLabel,
  reviewTone,
} from "../../format.ts";
import { GameCover } from "../GameCover.tsx";

export interface LibraryCardProps {
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

/**
 * Library-only Mantine card. The shared GameCard stays untouched for the
 * Steam Collection and Smart Collection previews until they are converted.
 */
export function LibraryCard({ game, selected, onToggleSelected }: LibraryCardProps) {
  const location = useLocation();
  const flag = ownershipFlag(game);
  const review = reviewPillLabel(game.reviewScore);
  const reviewLabel = reviewCardLabel(game.reviewTier, game.reviewCount);
  const tags = game.tags.slice(0, 2).map((tag) => tag.name);

  return (
    <Card
      component="article"
      className={`game-card${selected ? " is-selected" : ""}`}
      data-selected={selected ? "true" : "false"}
      padding="sm"
      radius="md"
      withBorder
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
              <Badge className="pill pill-installed" color="green" variant="light">
                <span className="status-dot" aria-hidden="true" />
                Installed
              </Badge>
            ) : game.installed === null ? (
              <Badge className="pill pill-installed is-unknown" variant="light">
                Unknown
              </Badge>
            ) : (
              <span />
            )}
            {review !== null && (
              <Badge
                className={`review-pill ${reviewTone(game.reviewScore)}`}
                variant="light"
                title={game.reviewTier ?? undefined}
              >
                {review}
              </Badge>
            )}
          </div>
        </div>
        <Stack gap={4}>
          <Title order={3} className="game-name" title={game.name}>
            {game.name}
          </Title>
          <Text component="p" className="game-meta" size="xs">
            <span>{formatPlaytime(game.playtimeMinutes)}</span>
            {flag !== null && (
              <Badge className="ownership-flag" variant="outline" size="xs">
                {flag}
              </Badge>
            )}
          </Text>
          <Text component="p" className={`game-review review-text ${reviewTone(game.reviewScore)}`}>
            {reviewLabel}
          </Text>
          <Text component="p" className="game-tags">
            {tags.length > 0 ? tags.join(" · ") : "No tags yet"}
          </Text>
          <Text
            component="span"
            className={`tag-status is-${game.metadata.tagsStatus}`}
            title={`Tags: ${game.metadata.tagsStatus}`}
          >
            Tags: {game.metadata.tagsStatus}
          </Text>
        </Stack>
      </Link>
      <Box className="select-check">
        <Checkbox
          size="md"
          styles={{ input: { width: 24, height: 24 } }}
          checked={selected}
          onChange={() => onToggleSelected(game.appId)}
          aria-label={`Select ${game.name}`}
        />
      </Box>
    </Card>
  );
}
