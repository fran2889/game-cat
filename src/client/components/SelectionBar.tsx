import { useNavigate } from "react-router-dom";
import { ApiError } from "../api.ts";
import {
  MAX_SELECTION_FOR_NEW,
  MAX_SELECTION_FOR_REFRESH,
  canCreateFromSelection,
  canRefreshSelection,
  selectionLimitMessages,
} from "../browse.ts";
import { useBrowse } from "../browse-context.tsx";
import { formatCount } from "../format.ts";
import { useRefresh } from "../refresh-context.tsx";
import { handoffFromSelection, SMART_COLLECTION_DRAFT_STATE } from "../smart-handoff.ts";
import { useToast } from "./ToastProvider.tsx";

export interface SelectionBarProps {
  /** Saved Smart Collection editors add selected Games to their `game` Rule. */
  onAddToRules?(): void;
  addToRulesDisabled?: boolean;
  addToRulesDisabledReason?: string;
}

/**
 * Selection actions shared by every Library-like view. The New from selection
 * handoff is router state so #31/#32 can open the editor without re-fetching.
 */
export function SelectionBar({
  onAddToRules,
  addToRulesDisabled = false,
  addToRulesDisabledReason,
}: SelectionBarProps = {}) {
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

  const explanation = [
    ...selectionLimitMessages(selectedCount),
    ...(addToRulesDisabled && addToRulesDisabledReason !== undefined
      ? [addToRulesDisabledReason]
      : []),
  ].join(" ");

  return (
    <div className="selection-bar" role="region" aria-label="Selection actions">
      <span className="selection-count">{formatCount(selectedCount)} selected</span>
      {explanation !== "" && <span className="selection-hint">{explanation}</span>}
      <div className="selection-actions">
        <button
          type="button"
          className="button"
          onClick={clearSelection}
          disabled={selectedCount === 0}
        >
          Clear
        </button>
        <button
          type="button"
          className="button"
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
        </button>
        <button
          type="button"
          className="primary"
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
        </button>
        {onAddToRules !== undefined && (
          <button
            type="button"
            className="button"
            onClick={onAddToRules}
            disabled={addToRulesDisabled || selectedCount === 0}
            title={
              addToRulesDisabledReason ??
              (selectedCount === 0
                ? "Select at least one game to add to the current rules."
                : undefined)
            }
          >
            Add to current rules
          </button>
        )}
      </div>
    </div>
  );
}
