import { Anchor, Badge, Box, Card, Checkbox, Group, Stack, Text, Title } from "@mantine/core";
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

/** The grid card shared by the Library, Steam Collection, and editor preview. */
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
      padding={0}
      radius="md"
      withBorder
      style={
        selected
          ? {
              borderColor: "var(--mantine-primary-color-filled)",
              boxShadow: "0 0 0 1px var(--mantine-primary-color-filled)",
            }
          : undefined
      }
    >
      <Anchor
        className="card-open"
        component={Link}
        to={{ pathname: `/games/${game.appId}`, search: location.search }}
        state={{ backgroundLocation: location }}
        c="inherit"
        display="block"
        underline="never"
      >
        <Box className="game-cover-wrap">
          <GameCover appId={game.appId} name={game.name} art="library" />
          <Group
            className="card-pills"
            pos="absolute"
            top={8}
            left={8}
            right={8}
            justify="space-between"
            align="flex-start"
            gap={6}
            wrap="nowrap"
            style={{ pointerEvents: "none" }}
          >
            {game.installed === true ? (
              <Badge className="pill pill-installed" color="green" variant="light" tt="none">
                <Box component="span" w={5} h={5} bg="green.5" bdrs="50%" aria-hidden="true" />
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
                title={reviewLabel}
              >
                {review}
              </Badge>
            )}
          </Group>
        </Box>
        <Stack className="card-body" gap={4} p="sm" pr={36}>
          <Title order={3} title={game.name} fz="sm" lineClamp={1}>
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
          <Text component="p" className="game-tags" size="xs" truncate>
            {tags.length > 0 ? tags.join(" · ") : "No tags yet"}
          </Text>
        </Stack>
      </Anchor>
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
