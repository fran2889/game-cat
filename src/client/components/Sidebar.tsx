import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { Status, SteamCollectionSummary } from "../../shared/types.ts";
import { fetchSteamCollections } from "../api.ts";
import { useToast } from "./ToastProvider.tsx";

export interface SidebarProps {
  status: Status | null;
  open: boolean;
  onClose(): void;
  onRetryStatus(): void;
}

const navClass = ({ isActive }: { isActive: boolean }): string =>
  `side-item${isActive ? " is-active" : ""}`;

export function Sidebar({ status, open, onClose, onRetryStatus }: SidebarProps) {
  const { showToast } = useToast();
  const location = useLocation();
  const account = status?.steam.account ?? null;
  const gameCount = status?.library.gameCount ?? 0;
  const installedCount = status?.library.installedCount ?? 0;
  const [steamCollections, setSteamCollections] = useState<SteamCollectionSummary[]>([]);
  const lastScanAt = status?.library.lastScanAt ?? null;

  useEffect(() => {
    const controller = new AbortController();
    void fetchSteamCollections({ pageSize: 200 }, controller.signal)
      .then((response) => setSteamCollections(response.data))
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") {
          setSteamCollections([]);
        }
      });
    return () => controller.abort();
  }, [lastScanAt, status]);

  const refreshLine = (() => {
    if (status === null) {
      return "Waiting for the server.";
    }
    if (status.steam.state === "not_found") {
      return "Steam was not found. The Library stays browsable.";
    }
    if (status.steam.state === "no_account") {
      return "No Steam Account selected yet.";
    }
    if (status.library.lastScanStatus === "never") {
      return "No Refresh has run yet.";
    }
    return `Last scan: ${status.library.lastScanStatus}.`;
  })();

  return (
    <aside
      id="sidebar"
      className={`sidebar${open ? " is-open" : ""}`}
      aria-label="Library navigation"
    >
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          GC
        </span>
        <span className="brand-name">game-cat</span>
        {status !== null && <span className="brand-version">v{status.app.version}</span>}
        <button
          type="button"
          className="icon-button sidebar-close"
          aria-label="Close navigation"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <nav className="side-section" aria-label="Views">
        <div className="side-list">
          <NavLink to="/" end className={navClass} onClick={onClose}>
            <span className="side-icon" aria-hidden="true">
              ▤
            </span>
            <span className="label">All games</span>
            <span className="count">{gameCount}</span>
          </NavLink>
          <NavLink to="/installed" className={navClass} onClick={onClose}>
            <span className="side-icon" aria-hidden="true">
              ✓
            </span>
            <span className="label">Installed</span>
            <span className="count">{installedCount}</span>
          </NavLink>
        </div>
      </nav>

      <section className="side-section" aria-labelledby="smart-heading">
        <div className="side-heading">
          <h2 id="smart-heading">Smart collections</h2>
          <NavLink
            to="/smart/new"
            className="icon-button"
            aria-label="New Smart Collection"
            onClick={onClose}
          >
            +
          </NavLink>
        </div>
        <p className="side-empty">
          No Smart Collections yet.{" "}
          <NavLink to="/smart/new" onClick={onClose}>
            Create one
          </NavLink>
          .
        </p>
      </section>

      <section className="side-section" aria-labelledby="steam-heading">
        <div className="side-heading">
          <h2 id="steam-heading">Steam collections</h2>
        </div>
        <p className="side-note">Read-only mirror · never written back</p>
        {steamCollections.length === 0 ? (
          <p className="side-empty">No Steam Collections mirrored yet. They appear after a scan.</p>
        ) : (
          <div className="side-list">
            {steamCollections.map((collection) => (
              <NavLink
                key={collection.id}
                to={`/steam/${encodeURIComponent(collection.id)}`}
                className={navClass}
                onClick={onClose}
                title={collection.isDynamic ? `${collection.name} (dynamic)` : collection.name}
              >
                <span className="side-lock" aria-label="Read-only">
                  🔒
                </span>
                <span className="label">{collection.name}</span>
                <span className="count">
                  {collection.isDynamic ? "dyn" : (collection.gameCount ?? 0)}
                </span>
              </NavLink>
            ))}
          </div>
        )}
      </section>

      <div className="sidebar-foot">
        <section className="status-card" aria-label="Refresh status">
          <div className="status-line">
            <span
              className={`status-dot ${
                status === null || status.steam.state === "not_found" ? "status-warn" : "status-ok"
              }`}
              aria-hidden="true"
            />
            <strong>Refresh</strong>
          </div>
          <p className="status-meta">{refreshLine}</p>
          <button
            type="button"
            className="button status-button"
            onClick={() => showToast("Refresh runs arrive in a later build. Nothing was changed.")}
          >
            Refresh
          </button>
          <NavLink to="/errors" className="status-link" onClick={onClose}>
            View refresh errors
          </NavLink>
        </section>

        <section className="account" aria-label="Steam Account">
          <span className="avatar" aria-hidden="true">
            {account === null ? "?" : account.personaName.slice(0, 1).toUpperCase()}
          </span>
          <div className="account-copy">
            <p className="account-name">
              {account === null ? "No Steam Account" : account.personaName}
            </p>
            <p className="account-meta">
              {account === null ? "Choose one during setup" : account.steamId64}
            </p>
          </div>
        </section>

        {location.pathname === "/onboarding" && (
          <button type="button" className="button" onClick={onRetryStatus}>
            Recheck status
          </button>
        )}
      </div>
    </aside>
  );
}
