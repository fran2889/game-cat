import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useLocation } from "react-router-dom";
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

const navClass = ({ isActive }: { isActive: boolean }): string =>
  `side-item${isActive ? " is-active" : ""}`;

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
        {smartError !== null ? (
          <p className="side-empty">
            Smart Collections could not be loaded.{" "}
            <button
              type="button"
              className="button button-small"
              onClick={() => void reloadSmartCollections()}
            >
              Retry
            </button>
          </p>
        ) : smartLoading && smartCollections.length === 0 ? (
          <p className="side-empty">Loading Smart Collections…</p>
        ) : smartCollections.length === 0 ? (
          <p className="side-empty">
            No Smart Collections yet.{" "}
            <NavLink to="/smart/new" onClick={onClose}>
              Create one
            </NavLink>
            .
          </p>
        ) : (
          <div className="side-list" data-testid="smart-collection-list">
            {smartCollections.map((collection) => (
              <NavLink
                key={collection.id}
                to={`/smart/${encodeURIComponent(collection.id)}`}
                className={navClass}
                onClick={onClose}
                title={collection.name}
              >
                <span className="side-icon" aria-hidden="true">
                  ✦
                </span>
                <span className="label">{collection.name}</span>
                <span className="count">{formatCount(collection.matchCount)}</span>
              </NavLink>
            ))}
          </div>
        )}
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
                <span className="side-lock" role="img" aria-label="Read-only">
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
        <section className="status-card" aria-label="Refresh status" aria-live="polite">
          <div className="status-line">
            <span
              className={`status-dot ${unhealthy ? "status-warn" : "status-ok"}`}
              aria-hidden="true"
            />
            <strong>{cardTitle}</strong>
          </div>
          {status === null ? (
            <p className="status-meta">Waiting for the server.</p>
          ) : (
            <>
              <p className="status-meta">
                {formatCount(gameCount)} games · {formatCount(installedCount)} installed
              </p>
              <p className="status-meta">Data as of {formatRelativeTime(refreshedAt)}</p>
            </>
          )}
          <button
            type="button"
            className="button status-button"
            onClick={() => void startFetch()}
            disabled={isRunning || status === null}
          >
            Fetch
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

        {status?.steam.ambiguous === true && (
          <p className="side-empty" role="status" data-testid="ambiguous-account-warning">
            Several Steam Accounts were found.{" "}
            <NavLink to="/settings" onClick={onClose}>
              Choose Account
            </NavLink>
            .
          </p>
        )}

        <NavLink to="/settings" className="status-link" onClick={onClose}>
          Settings
        </NavLink>

        {location.pathname === "/onboarding" && (
          <button type="button" className="button" onClick={onRetryStatus}>
            Recheck status
          </button>
        )}
      </div>
    </aside>
  );
}
