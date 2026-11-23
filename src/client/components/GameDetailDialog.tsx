import { useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import type { GameDetail, ReviewTone } from "../../shared/types.ts";
import { ApiError, gameDetailQueryOptions } from "../api.ts";
import {
  dash,
  formatBytes,
  formatCount,
  formatDate,
  formatPlaytime,
  formatTimestamp,
  ownershipLabel,
  platformLabels,
  reviewColor,
  reviewSummaryLabel,
  reviewTone,
} from "../format.ts";
import { GameCover } from "./GameCover.tsx";
import { useToast } from "./ToastProvider.tsx";

export interface DetailBackground {
  pathname: string;
  search: string;
  hash: string;
}

export interface GameDetailDialogProps {
  appId: string;
  background: DetailBackground;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; detail: GameDetail }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

function sourceStatusLabel(
  source: "tags" | "store" | "review",
  status: string,
  detail: GameDetail,
): string {
  if (source === "store" && status === "unavailable") {
    return "Not available on the store";
  }
  if (source === "review" && detail.reviewCount === 0) {
    return "No user reviews";
  }
  if (source === "review" && detail.reviewScore === null && status !== "ok") {
    return "Reviews unavailable";
  }
  return status;
}

export function GameDetailDialog({ appId, background }: GameDetailDialogProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const parsed = /^\d+$/.test(appId) ? Number.parseInt(appId, 10) : null;
  const appIdValue = parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  const detailQuery = useQuery({
    ...gameDetailQueryOptions(appIdValue ?? 0),
    enabled: appIdValue !== null,
  });
  const detail = detailQuery.data ?? null;
  const notFound =
    appIdValue === null ||
    (detailQuery.error instanceof ApiError && detailQuery.error.status === 404);
  const failure = detailQuery.error;
  const errorMessage =
    failure === null || (failure instanceof ApiError && failure.status === 404)
      ? null
      : failure instanceof ApiError && failure.status === null
        ? "Cannot reach game-cat. Is the server still running?"
        : failure.message;
  const state: LoadState = notFound
    ? { kind: "not_found" }
    : errorMessage !== null
      ? { kind: "error", message: errorMessage }
      : detail !== null
        ? { kind: "ready", detail }
        : { kind: "loading" };

  const closeTo = (destination: { pathname: string; search: string; hash: string }) => {
    navigate(
      { pathname: destination.pathname, search: destination.search, hash: destination.hash },
      { replace: true },
    );
  };

  // Mantine's `lockScroll` injects a runtime style sheet through
  // react-remove-scroll, which the CSP blocks (#96). The static class locks the
  // page; padding compensates for the removed scrollbar so the shell does not
  // jump when the dialog opens. Declared before focus restoration so the
  // cleanup unlocks the page first.
  useEffect(() => {
    const { body, documentElement } = document;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
    const previousPadding = body.style.paddingRight;
    body.classList.add("is-scroll-locked");
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }
    return () => {
      body.classList.remove("is-scroll-locked");
      body.style.paddingRight = previousPadding;
    };
  }, []);

  // Mantine's Modal owns the focus trap, Escape handling, and overlay click.
  // Focus restoration is explicit here because closing navigates and unmounts
  // the modal in the same render; capturing the opener keeps the documented
  // "return to the card" behaviour deterministic.
  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const restore = restoreFocusRef.current;
      if (restore !== null && document.contains(restore)) {
        restore.focus();
      }
    };
  }, []);

  const close = () => closeTo(background);

  const installed = detail?.installed === true;
  const reviewSummary = (() => {
    if (detail === null) {
      return "—";
    }
    return reviewSummaryLabel(detail.reviewScore, detail.reviewTier, detail.reviewCount);
  })();

  return (
    <Modal.Root
      opened
      onClose={close}
      trapFocus
      closeOnEscape
      returnFocus={false}
      lockScroll={false}
      yOffset={0}
      transitionProps={{ duration: 0 }}
    >
      <Modal.Overlay />
      <Modal.Content
        className="detail-dialog"
        aria-label={detail?.name ?? "Game detail"}
        styles={{
          inner: { padding: 0, alignItems: "stretch", justifyContent: "flex-end" },
          content: {
            flex: "0 0 min(560px, 100vw)",
            width: "min(560px, 100vw)",
            maxWidth: "none",
            marginLeft: "auto",
            marginRight: 0,
            borderRadius: 0,
          },
        }}
      >
        <Modal.Body p={0} h="100%">
          <Box
            className="detail-panel"
            pos="relative"
            h="100%"
            style={{ display: "flex", flexDirection: "column" }}
          >
            <ActionIcon
              className="detail-close"
              aria-label="Close game detail"
              onClick={close}
              variant="default"
              size="lg"
              pos="absolute"
              top={10}
              right={10}
              style={{ zIndex: 3 }}
            >
              ×
            </ActionIcon>

            {state.kind === "loading" && (
              <Box
                className="detail-loading"
                aria-busy="true"
                aria-label="Loading game detail"
                p="xl"
                pt={56}
              >
                <Stack gap="sm">
                  <Skeleton height={180} radius="md" />
                  <Skeleton height={12} radius="xl" />
                  <Skeleton height={12} radius="xl" width="55%" />
                </Stack>
              </Box>
            )}

            {state.kind === "not_found" && (
              <Stack className="detail-state" role="status" gap="sm" m="auto" p="xl" maw={420}>
                <Text size="xs" c="gray.5" tt="uppercase" fw={700}>
                  Library
                </Text>
                <Title order={2} id="detail-title">
                  Not found
                </Title>
                <Text c="gray.5">
                  That Game does not exist in this Library. Check the address, or return to it.
                </Text>
                <Group>
                  <Button
                    component={Link}
                    to="/"
                    onClick={(event) => {
                      event.preventDefault();
                      closeTo({ pathname: "/", search: "", hash: "" });
                    }}
                  >
                    Back to Library
                  </Button>
                </Group>
              </Stack>
            )}

            {state.kind === "error" && (
              <Stack className="detail-state" role="alert" gap="sm" m="auto" p="xl" maw={420}>
                <Title order={2} id="detail-title">
                  Cannot load this Game
                </Title>
                <Text c="gray.5">{state.message}</Text>
                <Group>
                  <Button variant="default" onClick={() => void detailQuery.refetch()}>
                    Retry
                  </Button>
                </Group>
              </Stack>
            )}

            {detail !== null && (
              <>
                <Box
                  className="detail-banner"
                  pos="relative"
                  style={{ aspectRatio: "460 / 215", flex: "none" }}
                >
                  <GameCover appId={detail.appId} name={detail.name} className="detail-cover" />
                  <Box pos="absolute" left={16} right={16} bottom={12} style={{ zIndex: 2 }}>
                    <Title order={2} id="detail-title" size="h4">
                      {detail.name}
                    </Title>
                    <Group className="detail-badges" gap={6} mt={6}>
                      <Badge className="badge" color={installed ? "green" : "gray"} variant="light">
                        {detail.installed === true
                          ? "Installed"
                          : detail.installed === false
                            ? "Not installed"
                            : "Install unknown"}
                      </Badge>
                      <Badge
                        className="badge"
                        color={detail.ownershipStatus === "owned" ? "green" : "yellow"}
                        variant="light"
                        tt="none"
                      >
                        {ownershipLabel(detail.ownershipStatus)}
                      </Badge>
                      <Badge className="badge" variant="default" tt="none">
                        App {detail.appId}
                      </Badge>
                    </Group>
                  </Box>
                </Box>

                <ScrollArea
                  className="detail-scroll"
                  style={{ flex: 1, minHeight: 0 }}
                  type="auto"
                  p="md"
                  viewportProps={{
                    tabIndex: 0,
                    role: "region",
                    "aria-label": "Game details",
                  }}
                >
                  <Box className="stat-grid">
                    <Stat label="Playtime" value={formatPlaytime(detail.playtimeMinutes)} />
                    <Stat label="Last played" value={formatDate(detail.lastPlayedAt)} />
                    <Stat
                      label="Released"
                      value={dash(detail.releaseDateRaw ?? detail.releaseYear)}
                    />
                    <Stat label="Metacritic" value={dash(detail.metacriticScore)} />
                    <Stat
                      label="Review"
                      value={reviewSummary}
                      tone={reviewTone(detail.reviewScore)}
                    />
                    <Stat label="Type" value={dash(detail.type)} />
                    <Stat
                      label="Platforms"
                      value={platformLabels(detail.platforms).join(", ") || "—"}
                    />
                    <Stat label="Size on disk" value={formatBytes(detail.sizeOnDiskBytes)} />
                  </Box>

                  <DetailSection title="Genres">
                    <ChipRow values={detail.genres} />
                  </DetailSection>
                  <DetailSection title="Storefront Categories">
                    <ChipRow values={detail.categories} />
                  </DetailSection>
                  <DetailSection title="Developers">
                    <ChipRow values={detail.developers} />
                  </DetailSection>
                  <DetailSection title="Publishers">
                    <ChipRow values={detail.publishers} />
                  </DetailSection>

                  <DetailSection title="Tags · SteamSpy votes">
                    {detail.tags.length === 0 ? (
                      <Text c="gray.5" size="sm">
                        No tags yet
                      </Text>
                    ) : (
                      <Group className="tag-row" gap={4}>
                        {detail.tags.map((tag) => (
                          <Badge className="tag-chip" key={tag.name} variant="default">
                            {tag.name}
                            <Text component="span" className="votes" size="xs" c="gray.5">
                              {" "}
                              {formatCount(tag.votes)}
                            </Text>
                          </Badge>
                        ))}
                      </Group>
                    )}
                  </DetailSection>

                  <DetailSection title="Steam Collections">
                    {detail.steamCollections.length === 0 ? (
                      <Text c="gray.5" size="sm">
                        —
                      </Text>
                    ) : (
                      <Group className="chip-row" gap={4}>
                        {detail.steamCollections.map((collection) => (
                          <Badge className="chip" key={collection.id} variant="default" tt="none">
                            {collection.name}
                          </Badge>
                        ))}
                      </Group>
                    )}
                  </DetailSection>

                  <DetailSection title="Metadata status">
                    <Stack className="source-list" gap={4}>
                      {(
                        [
                          [
                            "Tags",
                            "tags",
                            detail.metadata.tagsStatus,
                            detail.metadata.tagsFetchedAt,
                          ],
                          [
                            "Storefront",
                            "store",
                            detail.metadata.storeStatus,
                            detail.metadata.storeFetchedAt,
                          ],
                          [
                            "Reviews",
                            "review",
                            detail.metadata.reviewStatus,
                            detail.metadata.reviewFetchedAt,
                          ],
                        ] as const
                      ).map(([label, source, status, fetchedAt]) => (
                        <Text key={label} component="p" size="sm" c="gray.5">
                          <Text component="span" aria-hidden="true">
                            ●{" "}
                          </Text>
                          <Text component="span" fw={700} c="var(--mantine-color-text)">
                            {label}:
                          </Text>{" "}
                          {sourceStatusLabel(source, status, detail)}
                          {fetchedAt !== null && fetchedAt !== undefined && (
                            <Text component="span" c="gray.5">
                              {" "}
                              · {formatTimestamp(fetchedAt)}
                            </Text>
                          )}
                        </Text>
                      ))}
                    </Stack>
                  </DetailSection>
                </ScrollArea>

                <Text className="launch-note" size="xs" c="yellow" px="md" py="xs" mx="md" my="xs">
                  Launch opens the game through Steam. game-cat never writes Steam files; the store
                  link is safe.
                </Text>
                <Group className="detail-actions" gap="sm" px="md" py="sm" wrap="wrap">
                  <Button
                    component="a"
                    href={`https://store.steampowered.com/app/${detail.appId}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on Steam Store
                  </Button>
                  {installed ? (
                    <Button
                      component="a"
                      variant="default"
                      href={`steam://rungameid/${detail.appId}`}
                      onClick={() => showToast("Opening Steam…")}
                    >
                      Launch
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      disabled
                      title="Install the game in Steam to launch it."
                    >
                      Launch
                    </Button>
                  )}
                </Group>
              </>
            )}
          </Box>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: ReviewTone }) {
  return (
    <Paper p="xs" radius="sm" withBorder>
      <Text size="xs" c="gray.5" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text size="sm" fw={600} c={tone === undefined ? undefined : reviewColor(tone)}>
        {value}
      </Text>
    </Paper>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack className="detail-section" gap={6} mt="md">
      <Title order={3} size="xs" c="gray.5" tt="uppercase">
        {title}
      </Title>
      {children}
    </Stack>
  );
}

function ChipRow({ values }: { values: string[] }) {
  if (values.length === 0) {
    return (
      <Text c="gray.5" size="sm">
        —
      </Text>
    );
  }
  return (
    <Group className="chip-row" gap={4}>
      {values.map((value) => (
        <Badge className="chip" key={value} variant="default" tt="none">
          {value}
        </Badge>
      ))}
    </Group>
  );
}
