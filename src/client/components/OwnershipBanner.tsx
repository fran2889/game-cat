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

  return (
    <div
      className={`banner ${state === "partial" || state === "empty" ? "banner-warning" : "banner-error"}`}
      role={state === "invalid_key" || state === "error" ? "alert" : "status"}
    >
      <div>
        <strong>Ownership incomplete</strong>
        {error !== null && state !== "empty" && (
          <span className="refresh-error-code"> {error.code}</span>
        )}
        <p>{detail}</p>
        <p className="ownership-counts">
          Owned {counts.owned} · Local only {counts.localOnly} · Unknown {counts.unknown}
        </p>
      </div>
      <div className="banner-actions">
        <Link to="/errors" className="button">
          View refresh errors
        </Link>
        <Link to="/onboarding" className="button">
          Fix API key
        </Link>
        <button
          type="button"
          className="button"
          onClick={() => void startOwnershipRetry()}
          disabled={isRunning}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
