import { Alert, Badge, Button, Group, Stack, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import type { Status } from "../../shared/types.ts";
import { useRefresh } from "../refresh-context.tsx";

/**
 * Ownership status surface for the Library (spec §6.10, §7.2, §7.7).
 *
 * The card title is the documented `Ownership incomplete` state; the banner
 * keeps the owned/local-only/unknown counts and offers View refresh errors,
 * Fix API key, and Retry (`{ scope: "ownership" }`).
 */
export interface OwnershipBannerProps {
  status: Status;
}

export function OwnershipBanner({ status }: OwnershipBannerProps) {
  const { state, counts, error } = status.ownership;
  const { isRunning, startOwnershipRetry } = useRefresh();
  if (state !== "invalid_key" && state !== "empty" && state !== "partial" && state !== "error") {
    return null;
  }

  const detail = (() => {
    switch (state) {
      case "invalid_key":
        return (
          error?.message ??
          "Steam rejected the Web API key. Fix the key, then retry. Your cached Library was kept."
        );
      case "empty":
        return "Steam returned no owned Games. If this Account owns Games, its Steam profile may be private. Nothing was deleted.";
      case "partial":
        return (
          error?.message ??
          "Steam returned fewer Games than it reported, so absent Games were kept."
        );
      default:
        return error?.message ?? "Steam could not be reached. Your cached Library was kept.";
    }
  })();

  const warning = state === "partial" || state === "empty";

  return (
    <Alert
      className={`banner ${warning ? "banner-warning" : "banner-error"}`}
      role={state === "invalid_key" || state === "error" ? "alert" : "status"}
      color={warning ? "yellow" : "red"}
      variant="light"
      mb="md"
    >
      <Group align="flex-start" gap="md" wrap="wrap">
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs" wrap="wrap">
            <Text fw={700}>Ownership incomplete</Text>
            {error !== null && state !== "empty" && (
              <Badge className="refresh-error-code" variant="default">
                {error.code}
              </Badge>
            )}
          </Group>
          <Text size="sm" c="gray.5">
            {detail}
          </Text>
          <Text className="ownership-counts" size="sm">
            Owned {counts.owned} · Local only {counts.localOnly} · Unknown {counts.unknown}
          </Text>
        </Stack>
        <Group className="banner-actions" gap="xs" wrap="wrap">
          <Button component={Link} to="/errors" variant="default">
            View refresh errors
          </Button>
          <Button component={Link} to="/onboarding" variant="default">
            Fix API key
          </Button>
          <Button variant="default" onClick={() => void startOwnershipRetry()} disabled={isRunning}>
            Retry
          </Button>
        </Group>
      </Group>
    </Alert>
  );
}
