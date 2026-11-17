import { Button, Group, Paper, Text } from "@mantine/core";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../../api.ts";
import {
  MAX_SELECTION_FOR_NEW,
  MAX_SELECTION_FOR_REFRESH,
  canCreateFromSelection,
  canRefreshSelection,
  selectionLimitMessages,
} from "../../browse.ts";
import { useBrowse } from "../../browse-context.tsx";
import { formatCount } from "../../format.ts";
import { useRefresh } from "../../refresh-context.tsx";
import { handoffFromSelection, SMART_COLLECTION_DRAFT_STATE } from "../../smart-handoff.ts";
import { useToast } from "../ToastProvider.tsx";

/**
 * Library-only Mantine selection bar. The shared SelectionBar stays untouched
 * for the Steam Collection view and Smart Collection editor until they are
 * converted.
 */
export function LibrarySelectionBar() {
  const { selectedIds, selectedCount, clearSelection } = useBrowse();
  const { showToast } = useToast();
  const { isRunning, startRun } = useRefresh();
  const navigate = useNavigate();

  const newDisabled = !canCreateFromSelection(selectedCount);
  const refreshDisabled = !canRefreshSelection(selectedCount) || isRunning;

  const createFromSelection = () => {
    if (newDisabled) {
      return;
    }
    const handoff = handoffFromSelection(selectedIds);
    clearSelection();
    navigate("/smart/new", { state: { [SMART_COLLECTION_DRAFT_STATE]: handoff } });
  };

  const refreshSelected = async (): Promise<void> => {
    if (refreshDisabled) {
      return;
    }
    try {
      const run = await startRun({ scope: "metadata", mode: "full", appIds: selectedIds });
      if (run !== null) {
        showToast("Metadata Refresh started.");
      }
    } catch (error) {
      showToast(
        error instanceof ApiError ? error.message : "The Metadata Refresh could not be started.",
      );
    }
  };

  const explanation = selectionLimitMessages(selectedCount).join(" ");

  return (
    <Paper
      component="div"
      className="selection-bar"
      role="region"
      aria-label="Selection actions"
      p="xs"
      radius="md"
      withBorder
    >
      <Group gap="sm" wrap="wrap">
        <Text component="span" className="selection-count">
          {formatCount(selectedCount)} selected
        </Text>
        {explanation !== "" && (
          <Text component="span" className="selection-hint" size="xs">
            {explanation}
          </Text>
        )}
        <Group className="selection-actions" gap="xs" ml="auto">
          <Button
            size="compact-xs"
            variant="default"
            onClick={clearSelection}
            disabled={selectedCount === 0}
          >
            Clear
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => void refreshSelected()}
            disabled={refreshDisabled}
            title={
              isRunning
                ? "A Refresh is already running."
                : selectedCount > MAX_SELECTION_FOR_REFRESH
                  ? `Refresh selected supports up to ${formatCount(MAX_SELECTION_FOR_REFRESH)} Games.`
                  : undefined
            }
          >
            Refresh selected
          </Button>
          <Button
            size="compact-xs"
            onClick={createFromSelection}
            disabled={newDisabled}
            title={
              selectedCount > MAX_SELECTION_FOR_NEW
                ? `New from selection supports up to ${formatCount(MAX_SELECTION_FOR_NEW)} Games.`
                : selectedCount === 0
                  ? "Select at least one game to create a Smart Collection."
                  : undefined
            }
          >
            + New from selection
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}
