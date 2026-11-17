import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Kbd,
  NativeSelect,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import type { Status } from "../../shared/types.ts";
import { useBrowse } from "../browse-context.tsx";
import { GAME_SORT_OPTIONS } from "../browse.ts";
import { useRefresh } from "../refresh-context.tsx";

export interface TopBarProps {
  status: Status | null;
  sidebarOpen: boolean;
  onOpenSidebar(): void;
  onRetryStatus(): void;
}

export function breadcrumbFor(pathname: string): { kicker: string; title: string } {
  if (pathname === "/") {
    return { kicker: "Library", title: "All games" };
  }
  if (pathname === "/installed") {
    return { kicker: "Library", title: "Installed" };
  }
  if (pathname === "/smart/new") {
    return { kicker: "Smart collections", title: "New collection" };
  }
  if (pathname.startsWith("/smart/")) {
    return { kicker: "Smart collections", title: "Smart Collection" };
  }
  if (pathname.startsWith("/steam/")) {
    return { kicker: "Steam collections", title: "Steam Collection" };
  }
  if (pathname === "/errors") {
    return { kicker: "Refresh", title: "Refresh errors" };
  }
  if (pathname.startsWith("/games/")) {
    return { kicker: "Library", title: "Game detail" };
  }
  if (pathname === "/onboarding") {
    return { kicker: "Setup", title: "First run" };
  }
  if (pathname === "/settings") {
    return { kicker: "Configuration", title: "Settings" };
  }
  return { kicker: "game-cat", title: "Not found" };
}

export function TopBar({ status, sidebarOpen, onOpenSidebar, onRetryStatus }: TopBarProps) {
  const location = useLocation();
  const breadcrumb = breadcrumbFor(location.pathname);
  const inEditor = location.pathname.startsWith("/smart/");
  const {
    viewKind,
    layout,
    setLayout,
    search,
    setSearch,
    clearSearch,
    sort,
    setSort,
    order,
    toggleOrder,
    installedOnly,
    setInstalledOnly,
  } = useBrowse();
  const [draft, setDraft] = useState(search);
  const searchRef = useRef<HTMLInputElement>(null);
  const { isRunning, startFetch } = useRefresh();

  useEffect(() => {
    setDraft(search);
  }, [search]);

  useEffect(() => {
    if (draft === search) {
      return;
    }
    const timer = window.setTimeout(() => {
      setSearch(draft);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, search, setSearch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const installedPressed = viewKind === "installed" || installedOnly;
  // Search maps to `?q=` on the Library views only; the editor, Steam
  // Collections, /errors, onboarding, and settings have no search result list.
  const searchEnabled = location.pathname === "/" || location.pathname === "/installed";

  return (
    <header className="topbar">
      <ActionIcon
        className="icon-button mobile-menu"
        variant="subtle"
        aria-label="Open navigation"
        aria-controls="sidebar"
        aria-expanded={sidebarOpen}
        onClick={onOpenSidebar}
      >
        ☰
      </ActionIcon>

      <Stack className="crumb" gap={0} miw={0}>
        <Text size="xs" fw={700} tt="uppercase" c="dimmed">
          {breadcrumb.kicker}
        </Text>
        <Title order={1} size="h4" fw={700} lineClamp={1}>
          {breadcrumb.title}
        </Title>
        <Text className="crumb-sub" size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {location.pathname === "/onboarding"
            ? "Steam folder, Account, key, and scan"
            : `${status?.library.gameCount ?? 0} games`}
        </Text>
      </Stack>

      <Group className="topbar-tools" gap="xs" wrap="wrap">
        {searchEnabled && (
          <TextInput
            className="search-wrap"
            ref={searchRef}
            type="search"
            size="sm"
            value={draft}
            placeholder="Search game names"
            aria-label="Search game names"
            autoComplete="off"
            leftSection={
              <Text component="span" aria-hidden="true" c="dimmed">
                ⌕
              </Text>
            }
            rightSection={
              draft === "" ? (
                <Kbd aria-hidden="true">/</Kbd>
              ) : (
                <ActionIcon
                  aria-label="Clear search"
                  variant="subtle"
                  size="sm"
                  onClick={() => {
                    setDraft("");
                    clearSearch();
                  }}
                >
                  ×
                </ActionIcon>
              )
            }
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        )}

        <NativeSelect
          className="select-wrap"
          aria-label="Sort by"
          size="sm"
          w={160}
          value={sort}
          data={GAME_SORT_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          onChange={(event) => setSort(event.currentTarget.value as typeof sort)}
        />

        <ActionIcon
          className="icon-button"
          aria-label={order === "desc" ? "Sort descending" : "Sort ascending"}
          aria-pressed={order === "desc"}
          variant="subtle"
          onClick={toggleOrder}
        >
          {order === "desc" ? "↓" : "↑"}
        </ActionIcon>

        <Button
          className="toggle-button"
          variant={installedPressed ? "light" : "default"}
          aria-pressed={installedPressed}
          disabled={viewKind === "installed"}
          title={
            viewKind === "installed"
              ? "This view already shows installed Games only."
              : "Show installed Games only"
          }
          onClick={() => setInstalledOnly(!installedOnly)}
        >
          ✓ Installed
        </Button>

        {!inEditor && (
          <Box className="segmented" role="group" aria-label="Layout">
            <Button.Group>
              <Button
                variant={layout === "grid" ? "light" : "default"}
                aria-label="Grid view"
                aria-pressed={layout === "grid"}
                px={8}
                onClick={() => setLayout("grid")}
              >
                ▦
              </Button>
              <Button
                variant={layout === "table" ? "light" : "default"}
                aria-label="Table view"
                aria-pressed={layout === "table"}
                px={8}
                onClick={() => setLayout("table")}
              >
                ☰
              </Button>
            </Button.Group>
          </Box>
        )}

        <Button
          className="primary"
          onClick={() => void startFetch()}
          disabled={isRunning}
          title={isRunning ? "A Refresh is already running." : undefined}
        >
          Fetch
        </Button>

        <Button component={Link} to="/smart/new" variant="default">
          + New collection
        </Button>

        {status === null && (
          <Button variant="default" onClick={onRetryStatus}>
            Retry
          </Button>
        )}
      </Group>
    </header>
  );
}
