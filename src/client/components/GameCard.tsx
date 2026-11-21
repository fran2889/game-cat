import {
  Anchor,
  Badge,
  Box,
  Card,
  Checkbox,
  Group,
  Stack,
  Text,
  Title,
  VisuallyHidden,
} from "@mantine/core";
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
  const reviewLabel =
    game.reviewCount === null ? "" : reviewCardLabel(game.reviewTier, game.reviewCount);
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
              // Filled, without the dot, matches the mockup. Black text keeps
              // the dark scheme's green-5 at 10.5:1; white is 2.0:1 and fails AA.
              <Badge
                className="pill pill-installed"
                color="green"
                variant="filled"
                c="black"
                tt="none"
              >
                Installed
              </Badge>
            ) : game.installed === null ? (
              <Badge
                className="pill pill-installed is-unknown"
                variant="default"
                c="dimmed"
                tt="none"
              >
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
                title={reviewLabel === "" ? undefined : reviewLabel}
              >
                {review}
                {reviewLabel !== "" && <VisuallyHidden> · {reviewLabel}</VisuallyHidden>}
              </Badge>
            )}
          </Group>
        </Box>
        <Stack className="card-body" gap={4}>
          <Title order={3} title={game.name} fz={12.5} lh={1.25} fw={650} lineClamp={1}>
            {game.name}
          </Title>
          <Group className="game-meta" gap={6} justify="space-between" wrap="nowrap">
            <Text component="span" fz={11} truncate>
              {formatPlaytime(game.playtimeMinutes)}
            </Text>
            {flag !== null && (
              <Text component="span" className="ownership-flag" fz={10}>
                {flag}
              </Text>
            )}
          </Group>
          <Text component="p" className="game-tags" fz={10.5} c="dark.3" truncate>
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
