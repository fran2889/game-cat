import { Link } from "react-router-dom";
import type { Status } from "../../shared/types.ts";

/**
 * Ownership status surface for the Library (spec §6.10, §7.2).
 *
 * #35 owns the full Refresh UI; this small banner only reports the documented
 * ownership states and offers the two recovery actions.
 */

export interface OwnershipBannerProps {
  status: Status;
  refreshing: boolean;
  onRetry(): void;
}

export function OwnershipBanner({ status, refreshing, onRetry }: OwnershipBannerProps) {
  const { state, counts, error } = status.ownership;
  if (state !== "invalid_key" && state !== "empty" && state !== "partial" && state !== "error") {
    return null;
  }

  const copy = (() => {
    switch (state) {
      case "invalid_key":
        return {
          title: "Steam rejected the Web API key.",
          detail:
            error?.message ??
            "Fix the key in onboarding, then retry. Your cached Library was kept.",
        };
      case "empty":
        return {
          title: "Steam returned no owned Games.",
          detail:
            "If this Account owns Games, its Steam profile may be private. Nothing was deleted.",
        };
      case "partial":
        return {
          title: "The ownership roster is incomplete.",
          detail:
            error?.message ??
            "Steam returned fewer Games than it reported, so absent Games were kept.",
        };
      default:
        return {
          title: "Ownership refresh failed.",
          detail: error?.message ?? "Steam could not be reached. Your cached Library was kept.",
        };
    }
  })();

  return (
    <div
      className={`banner ${state === "partial" || state === "empty" ? "banner-warning" : "banner-error"}`}
      role={state === "invalid_key" || state === "error" ? "alert" : "status"}
    >
      <div>
        <strong>{copy.title}</strong>
        <p>{copy.detail}</p>
        <p className="ownership-counts">
          Owned {counts.owned} · Local only {counts.localOnly} · Unknown {counts.unknown}
        </p>
      </div>
      <div className="banner-actions">
        {(state === "invalid_key" || state === "empty") && (
          <Link to="/onboarding" className="button">
            Fix API key
          </Link>
        )}
        <button type="button" className="button" onClick={onRetry} disabled={refreshing}>
          {refreshing ? "Retrying…" : "Retry"}
        </button>
      </div>
    </div>
  );
}
