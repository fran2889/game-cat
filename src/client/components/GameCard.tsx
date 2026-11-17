import { Badge, Box, Card, Checkbox, Group, Stack, Text, Title } from "@mantine/core";
import { Link, useLocation } from "react-router-dom";
import type { GameSummary } from "../../shared/types.ts";
import {
  formatPlaytime,
  ownershipLabel,
  reviewCardLabel,
  reviewColor,
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

function tagStatusColor(status: string): string {
  if (status === "ok") {
    return "green";
  }
  return status === "stale" || status === "error" ? "red" : "gray";
}

/** The grid card shared by the Library and Steam Collection views. */
export function GameCard({ game, selected, onToggleSelected }: GameCardProps) {
  const location = useLocation();
  const flag = ownershipFlag(game);
  const review = reviewPillLabel(game.reviewScore);
  const reviewLabel = reviewCardLabel(game.reviewTier, game.reviewCount);
  const tone = reviewTone(game.reviewScore);
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
        <Box className="game-cover-wrap">
          <GameCover appId={game.appId} name={game.name} />
          <Box className="card-pills">
            {game.installed === true ? (
              <Badge className="pill pill-installed" color="green" variant="light" tt="none">
                <Box component="span" className="status-dot" aria-hidden="true" />
                Installed
              </Badge>
            ) : game.installed === null ? (
              <Badge className="pill pill-installed is-unknown" variant="light" tt="none">
                Unknown
              </Badge>
            ) : (
              <span />
            )}
            {review !== null && (
              <Badge
                className={`review-pill ${tone}`}
                color={reviewColor(tone)}
                variant="light"
                tt="none"
                title={game.reviewTier ?? undefined}
              >
                {review}
              </Badge>
            )}
          </Box>
        </Box>
        <Stack gap={4}>
          <Title order={3} className="game-name" title={game.name} fz="sm">
            {game.name}
          </Title>
          <Group className="game-meta" gap={8} justify="space-between" wrap="nowrap">
            <Text component="span" size="xs">
              {formatPlaytime(game.playtimeMinutes)}
            </Text>
            {flag !== null && (
              <Badge className="ownership-flag" variant="outline" size="xs" tt="none">
                {flag}
              </Badge>
            )}
          </Group>
          <Text component="p" className={`game-review ${tone}`} size="xs" c={reviewColor(tone)}>
            {reviewLabel}
          </Text>
          <Text component="p" className="game-tags" size="xs">
            {tags.length > 0 ? tags.join(" · ") : "No tags yet"}
          </Text>
          <Text
            component="span"
            className={`tag-status is-${game.metadata.tagsStatus}`}
            title={`Tags: ${game.metadata.tagsStatus}`}
            size="xs"
            c={tagStatusColor(game.metadata.tagsStatus)}
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
