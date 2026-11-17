import { Alert, Badge, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import type { RefreshRun, Status } from "../../shared/types.ts";
import { useRefresh } from "../refresh-context.tsx";
import { METADATA_SOURCE_LABELS, refreshModeLabel, refreshPhaseFromStatus } from "../refresh.ts";
import { formatCount } from "../format.ts";

/**
 * The running banner, plus the persistent banner for a partial or failed run
 * (§7.7). It never blocks the Library: it sits above cached content and offers
 * no cancel action because v1 has no run cancellation.
 */
export function RefreshBanner() {
  const { status, activeRun, attentionRun, retryRun, isRunning } = useRefresh();

  if (activeRun !== null) {
    return <RunningBanner run={activeRun} status={status} />;
  }
  if (attentionRun !== null) {
    return (
      <FinishedBanner
        run={attentionRun}
        onRetry={() => void retryRun(attentionRun)}
        disabled={isRunning}
      />
    );
  }
  return null;
}

function RunningBanner({ run, status }: { run: RefreshRun; status: Status | null }) {
  const phase = refreshPhaseFromStatus(run, status);
  const total = run.total;
  const done = run.done;
  const percent = total !== null && total > 0 ? Math.min(100, (done / total) * 100) : null;

  return (
    <Paper
      className="banner refresh-banner refresh-running"
      role="status"
      aria-live="polite"
      p="sm"
      radius="md"
      withBorder
      mb="md"
    >
      <Group align="flex-start" gap="md" wrap="wrap">
        <Stack className="refresh-main" gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Group className="refresh-heading" gap="sm" wrap="wrap">
            <Text fw={700}>{refreshModeLabel(run)}</Text>
            <Badge className="refresh-phase" variant="default" tt="uppercase">
              {phase}
            </Badge>
            <Text className="refresh-progress-text" size="sm" c="gray.5">
              {total === null ? "Working…" : `${formatCount(done)} of ${formatCount(total)}`}
            </Text>
          </Group>
          <div
            className={`progress${percent === null ? " progress-indeterminate" : ""}`}
            role="progressbar"
            aria-label={`${refreshModeLabel(run)} progress`}
            aria-valuemin={0}
            aria-valuemax={total ?? undefined}
            aria-valuenow={total === null ? undefined : done}
          >
            <span style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
          {run.stats !== null && (
            <Group className="chip-row refresh-sources" gap={4}>
              {(["steamspy", "storefront", "steam_reviews"] as const).map((name) => {
                const counters = run.stats?.sources[name];
                if (counters === undefined) {
                  return null;
                }
                return (
                  <Badge
                    className="chip refresh-chip"
                    key={name}
                    variant="default"
                    size="lg"
                    radius="xl"
                    tt="none"
                  >
                    <Group gap={4} wrap="nowrap">
                      <Text component="span" fw={600} size="xs">
                        {METADATA_SOURCE_LABELS[name]}
                      </Text>
                      <Text component="span" size="xs">
                        {formatCount(counters.done)}/{formatCount(counters.candidates)}
                      </Text>
                      {counters.skipped > 0 && (
                        <Text
                          component="span"
                          className="refresh-chip-skipped"
                          size="xs"
                          c="gray.5"
                        >
                          {formatCount(counters.skipped)} skipped
                        </Text>
                      )}
                      {counters.failed > 0 && (
                        <Text component="span" className="refresh-chip-failed" size="xs" c="red">
                          {formatCount(counters.failed)} failed
                        </Text>
                      )}
                    </Group>
                  </Badge>
                );
              })}
            </Group>
          )}
          <Text className="refresh-note" size="xs" c="gray.5">
            The Library stays usable while this runs.
          </Text>
        </Stack>
        <Group className="banner-actions" gap="xs">
          <Button component={Link} to="/errors" variant="default">
            View refresh errors
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}

function FinishedBanner({
  run,
  onRetry,
  disabled,
}: {
  run: RefreshRun;
  onRetry(): void;
  disabled: boolean;
}) {
  const failed = run.status === "failed";
  const generic = "Fetch finished with some work incomplete.";
  const interrupted = run.error?.code === "INTERRUPTED";

  return (
    <Alert
      className={`banner refresh-banner ${failed ? "banner-error" : "banner-warning"}`}
      role={failed ? "alert" : "status"}
      color={failed ? "red" : "yellow"}
      variant="light"
      mb="md"
    >
      <Group align="flex-start" gap="md" wrap="wrap">
        <Stack className="refresh-main" gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Group className="refresh-heading" gap="sm" wrap="wrap">
            <Text fw={700}>
              {failed ? "Fetch failed" : "Fetch finished with some work incomplete."}
            </Text>
            {run.error !== null && (
              <Badge className="refresh-error-code" variant="default" tt="uppercase">
                {run.error.code}
              </Badge>
            )}
          </Group>
          <Text size="sm" c="gray.5">
            {run.error !== null ? run.error.message : generic}
          </Text>
          {interrupted && (
            <Text size="sm" c="gray.5">
              The next Fetch resumes pending work. Nothing that finished was rolled back.
            </Text>
          )}
        </Stack>
        <Group className="banner-actions" gap="xs" wrap="wrap">
          <Button component={Link} to="/errors" variant="default">
            View refresh errors
          </Button>
          <Button variant="default" onClick={onRetry} disabled={disabled}>
            Retry
          </Button>
        </Group>
      </Group>
    </Alert>
  );
}
