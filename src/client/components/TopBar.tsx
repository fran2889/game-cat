import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Status } from "../../shared/types.ts";

export interface TopBarProps {
  status: Status | null;
  sidebarOpen: boolean;
  onOpenSidebar(): void;
  onRetryStatus(): void;
}

export function breadcrumbFor(pathname: string): { kicker: string; title: string } {
  if (pathname === "/") {
    return { kicker: "Library", title: "All games" };
  }
  if (pathname === "/installed") {
    return { kicker: "Library", title: "Installed" };
  }
  if (pathname === "/smart/new") {
    return { kicker: "Smart collections", title: "New collection" };
  }
  if (pathname.startsWith("/smart/")) {
    return { kicker: "Smart collections", title: "Smart Collection" };
  }
  if (pathname.startsWith("/steam/")) {
    return { kicker: "Steam collections", title: "Steam Collection" };
  }
  if (pathname === "/errors") {
    return { kicker: "Refresh", title: "Refresh errors" };
  }
  if (pathname.startsWith("/games/")) {
    return { kicker: "Library", title: "Game detail" };
  }
  if (pathname === "/onboarding") {
    return { kicker: "Setup", title: "First run" };
  }
  return { kicker: "game-cat", title: "Not found" };
}

export function TopBar({ status, sidebarOpen, onOpenSidebar, onRetryStatus }: TopBarProps) {
  const location = useLocation();
  const breadcrumb = breadcrumbFor(location.pathname);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [descending, setDescending] = useState(false);
  const [installedOnly, setInstalledOnly] = useState(false);
  const [layout, setLayout] = useState<"grid" | "table">("grid");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button mobile-menu"
        aria-label="Open navigation"
        aria-controls="sidebar"
        aria-expanded={sidebarOpen}
        onClick={onOpenSidebar}
      >
        ☰
      </button>

      <div className="crumb">
        <span className="crumb-kicker">{breadcrumb.kicker}</span>
        <h1>{breadcrumb.title}</h1>
        <span className="crumb-sub">
          {location.pathname === "/onboarding"
            ? "Steam folder, Account, key, and scan"
            : `${status?.library.gameCount ?? 0} games`}
        </span>
      </div>

      <div className="topbar-tools">
        <div className="search-wrap">
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={searchRef}
            type="search"
            value={search}
            placeholder="Search game names"
            aria-label="Search game names"
            autoComplete="off"
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd aria-hidden="true">/</kbd>
          {search !== "" && (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={() => setSearch("")}
            >
              ×
            </button>
          )}
        </div>

        <label className="select-wrap">
          <span className="sr-only">Sort by</span>
          <select
            aria-label="Sort by"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="name">Name</option>
            <option value="playtime">Playtime</option>
            <option value="lastPlayed">Last played</option>
            <option value="releaseYear">Release year</option>
            <option value="metacritic">Metacritic</option>
            <option value="appId">App ID</option>
          </select>
        </label>

        <button
          type="button"
          className="icon-button"
          aria-label={descending ? "Sort descending" : "Sort ascending"}
          aria-pressed={descending}
          onClick={() => setDescending((current) => !current)}
        >
          {descending ? "↓" : "↑"}
        </button>

        <button
          type="button"
          className="toggle-button"
          aria-pressed={installedOnly}
          onClick={() => setInstalledOnly((current) => !current)}
        >
          ✓ Installed
        </button>

        <div className="segmented" role="group" aria-label="Layout">
          <button
            type="button"
            className="seg-button"
            aria-label="Grid view"
            aria-pressed={layout === "grid"}
            onClick={() => setLayout("grid")}
          >
            ▦
          </button>
          <button
            type="button"
            className="seg-button"
            aria-label="Table view"
            aria-pressed={layout === "table"}
            onClick={() => setLayout("table")}
          >
            ☰
          </button>
        </div>

        <Link to="/smart/new" className="primary">
          + New collection
        </Link>

        {status === null && (
          <button type="button" className="button" onClick={onRetryStatus}>
            Retry
          </button>
        )}
      </div>
    </header>
  );
}
