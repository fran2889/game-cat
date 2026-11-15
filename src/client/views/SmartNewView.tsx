import { useLocation } from "react-router-dom";
import { readDraftHandoff } from "../smart-handoff.ts";
import { PlaceholderView } from "./PlaceholderView.tsx";

/**
 * Route shell for #31/#32. It already consumes the New from selection handoff
 * so the Library can hand the editor a deterministic draft today.
 */
export function SmartNewView() {
  const location = useLocation();
  const handoff = readDraftHandoff(location.state);

  return (
    <PlaceholderView
      kicker="Smart collections"
      title={handoff?.name ?? "New Smart Collection"}
      description="The Rule editor arrives with the Smart Collection slice. This route is reserved so navigation, deep links, and the selection handoff already work."
    >
      {handoff !== null && (
        <section className="handoff-summary" aria-label="Selection handoff">
          <p>
            Prefilled from selection: {handoff.sourceAppIds.length}{" "}
            {handoff.sourceAppIds.length === 1 ? "game" : "games"}.
          </p>
          <p>
            One <code>AND game in [...]</code> Rule is ready with App IDs{" "}
            {handoff.sourceAppIds.slice(0, 8).join(", ")}
            {handoff.sourceAppIds.length > 8 ? "…" : ""}.
          </p>
        </section>
      )}
    </PlaceholderView>
  );
}
