import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import {
  ActionIcon,
  Anchor,
  Avatar,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  NavLink,
  Paper,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import type { Status } from "../../shared/types.ts";
import { steamCollectionsQueryOptions } from "../api.ts";
import { formatCount, formatRelativeTime } from "../format.ts";
import { useRefresh } from "../refresh-context.tsx";
import { dataAsOf, refreshCardTitle } from "../refresh.ts";
import { useSmartCollections } from "../smart-collections-context.tsx";

export interface SidebarProps {
  status: Status | null;
  open: boolean;
  onClose(): void;
  onRetryStatus(): void;
}

export function Sidebar({ status, open, onClose, onRetryStatus }: SidebarProps) {
  const location = useLocation();
  const { activeRun, isRunning, startFetch } = useRefresh();
  const {
    collections: smartCollections,
    loading: smartLoading,
    error: smartError,
    reload: reloadSmartCollections,
  } = useSmartCollections();
  const account = status?.steam.account ?? null;
  const gameCount = status?.library.gameCount ?? 0;
  const installedCount = status?.library.installedCount ?? 0;
  const steamCollectionsQuery = useQuery(steamCollectionsQueryOptions({ pageSize: 200 }));
  const steamCollections = steamCollectionsQuery.data?.data ?? [];
  const lastScanAt = status?.library.lastScanAt ?? null;
  const previousScanAt = useRef<string | null>(null);

  useEffect(() => {
    if (previousScanAt.current !== null && previousScanAt.current !== lastScanAt) {
      void steamCollectionsQuery.refetch();
    }
    previousScanAt.current = lastScanAt;
  }, [lastScanAt, steamCollectionsQuery.refetch]);

  const cardTitle = refreshCardTitle(status, activeRun);
  const refreshedAt = status === null ? null : dataAsOf(status);
  const unhealthy = cardTitle === "Not connected" || cardTitle === "Ownership incomplete";

  return (
    <aside
      id="sidebar"
      className={`sidebar${open ? " is-open" : ""}`}
      aria-label="Library navigation"
    >
      <Group className="brand" gap={10} px="sm" py="sm" wrap="nowrap">
        <ThemeIcon size={30} radius="md" variant="light" color="yellow" aria-hidden="true">
          <Text size="xs" fw={800} lts="0.03em">
            GC
          </Text>
        </ThemeIcon>
        <Text fw={700} size="sm">
          game-cat
        </Text>
        {status !== null && (
          <Badge variant="default" size="xs" radius="xl" tt="none" ff="mono" ml="auto">
            v{status.app.version}
          </Badge>
        )}
        <ActionIcon
          className="icon-button sidebar-close"
          aria-label="Close navigation"
          variant="subtle"
          onClick={onClose}
        >
          ×
        </ActionIcon>
      </Group>

      <Stack component="nav" aria-label="Views" gap={1} px="sm" py="xs">
        <SidebarLink
          to="/"
          label="All games"
          icon="▤"
          count={formatCount(gameCount)}
          active={location.pathname === "/"}
          onNavigate={onClose}
        />
        <SidebarLink
          to="/installed"
          label="Installed"
          icon="✓"
          count={formatCount(installedCount)}
          active={location.pathname === "/installed"}
          onNavigate={onClose}
        />
      </Stack>

      <Stack component="section" aria-labelledby="smart-heading" gap={1} px="sm" py="xs">
        <Group justify="space-between" gap="xs" px="xs" pt="xs" pb={6} wrap="nowrap">
          <Text component="h2" id="smart-heading" size="xs" fw={700} tt="uppercase" c="dimmed">
            Smart collections
          </Text>
          <ActionIcon
            component={Link}
            to="/smart/new"
            aria-label="New Smart Collection"
            variant="subtle"
            size="sm"
            onClick={onClose}
          >
            +
          </ActionIcon>
        </Group>
        {smartError !== null ? (
          <Text size="xs" c="dimmed" px="xs" py={4}>
            Smart Collections could not be loaded.{" "}
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => void reloadSmartCollections()}
            >
              Retry
            </Button>
          </Text>
        ) : smartLoading && smartCollections.length === 0 ? (
          <Text size="xs" c="dimmed" px="xs" py={4}>
            Loading Smart Collections…
          </Text>
        ) : smartCollections.length === 0 ? (
          <Text size="xs" c="dimmed" px="xs" py={4}>
            No Smart Collections yet.{" "}
            <Anchor component={Link} to="/smart/new" size="xs" underline="always" onClick={onClose}>
              Create one
            </Anchor>
            .
          </Text>
        ) : (
          <Stack gap={1} data-testid="smart-collection-list">
            {smartCollections.map((collection) => (
              <SidebarLink
                key={collection.id}
                to={`/smart/${encodeURIComponent(collection.id)}`}
                label={collection.name}
                icon="✦"
                count={formatCount(collection.matchCount)}
                active={location.pathname === `/smart/${encodeURIComponent(collection.id)}`}
                title={collection.name}
                onNavigate={onClose}
              />
            ))}
          </Stack>
        )}
      </Stack>

      <Stack component="section" aria-labelledby="steam-heading" gap={1} px="sm" py="xs">
        <Group gap="xs" px="xs" pt="xs" pb={6}>
          <Text component="h2" id="steam-heading" size="xs" fw={700} tt="uppercase" c="dimmed">
            Steam collections
          </Text>
        </Group>
        <Text size="xs" c="dimmed" px="xs">
          Read-only mirror · never written back
        </Text>
        {steamCollections.length === 0 ? (
          <Text size="xs" c="dimmed" px="xs" py={4}>
            No Steam Collections mirrored yet. They appear after a scan.
          </Text>
        ) : (
          <Stack gap={1}>
            {steamCollections.map((collection) => (
              <SidebarLink
                key={collection.id}
                to={`/steam/${encodeURIComponent(collection.id)}`}
                label={collection.name}
                icon="🔒"
                count={collection.isDynamic ? "dyn" : String(collection.gameCount ?? 0)}
                active={location.pathname === `/steam/${encodeURIComponent(collection.id)}`}
                title={collection.isDynamic ? `${collection.name} (dynamic)` : collection.name}
                onNavigate={onClose}
              />
            ))}
          </Stack>
        )}
      </Stack>

      <Divider mt="auto" />
      <Stack gap="sm" p="sm">
        <Paper
          component="section"
          className="status-card"
          aria-label="Refresh status"
          aria-live="polite"
          p="sm"
          radius="md"
          withBorder
        >
          <Stack gap={6}>
            <Group gap={6} wrap="nowrap">
              <Box
                aria-hidden="true"
                w={7}
                h={7}
                bg={unhealthy ? "yellow.5" : "green.5"}
                bdrs="50%"
                style={{
                  flex: "none",
                  boxShadow: "0 0 0 2px var(--mantine-color-dark-8)",
                }}
              />
              <Text component="strong" size="sm">
                {cardTitle}
              </Text>
            </Group>
            {status === null ? (
              <Text size="xs" c="dimmed">
                Waiting for the server.
              </Text>
            ) : (
              <>
                <Text size="xs" c="dimmed">
                  {formatCount(gameCount)} games · {formatCount(installedCount)} installed
                </Text>
                <Text size="xs" c="dimmed">
                  Data as of {formatRelativeTime(refreshedAt)}
                </Text>
              </>
            )}
            <Button
              variant="default"
              fullWidth
              onClick={() => void startFetch()}
              disabled={isRunning || status === null}
            >
              Fetch
            </Button>
            <Anchor
              component={Link}
              to="/errors"
              size="xs"
              c="dimmed"
              ta="center"
              underline="hover"
              onClick={onClose}
            >
              View refresh errors
            </Anchor>
          </Stack>
        </Paper>

        <Group component="section" aria-label="Steam Account" gap={9} p={2} wrap="nowrap">
          <Avatar radius="xl" size={30} color="yellow" variant="light" aria-hidden="true">
            {account === null ? "?" : account.personaName.slice(0, 1).toUpperCase()}
          </Avatar>
          <Box miw={0}>
            <Text size="xs" fw={600} truncate>
              {account === null ? "No Steam Account" : account.personaName}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {account === null ? "Choose one during setup" : account.steamId64}
            </Text>
          </Box>
        </Group>

        {status?.steam.ambiguous === true && (
          <Text size="xs" c="dimmed" role="status" data-testid="ambiguous-account-warning">
            Several Steam Accounts were found.{" "}
            <Anchor component={Link} to="/settings" size="xs" underline="always" onClick={onClose}>
              Choose Account
            </Anchor>
            .
          </Text>
        )}

        <Anchor
          component={Link}
          to="/settings"
          size="xs"
          c="dimmed"
          ta="center"
          underline="hover"
          onClick={onClose}
        >
          Settings
        </Anchor>

        {location.pathname === "/onboarding" && (
          <Button variant="default" onClick={onRetryStatus}>
            Recheck status
          </Button>
        )}
      </Stack>
    </aside>
  );
}

interface SidebarLinkProps {
  to: string;
  label: string;
  icon: string;
  count: string;
  active: boolean;
  title?: string;
  onNavigate(): void;
}

/** One sidebar row. Mantine owns the shape, hover, and active treatment. */
function SidebarLink({ to, label, icon, count, active, title, onNavigate }: SidebarLinkProps) {
  return (
    <NavLink
      component={Link}
      to={to}
      className="side-item"
      label={label}
      title={title}
      active={active}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      noWrap
      leftSection={
        <Text component="span" size="xs" aria-hidden="true">
          {icon}
        </Text>
      }
      rightSection={
        <Text component="span" size="xs" ff="mono" c={active ? undefined : "dimmed"}>
          {count}
        </Text>
      }
    />
  );
}
