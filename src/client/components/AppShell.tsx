import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import type { Status } from "../../shared/types.ts";
import type { ShellContext } from "../shell-context.ts";
import { Sidebar } from "./Sidebar.tsx";
import { TopBar } from "./TopBar.tsx";

export interface AppShellProps {
  status: Status | null;
  error: string | null;
  reloadStatus(): void;
}

export function AppShell({ status, error, reloadStatus }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    document.title = "game-cat";
  }, []);

  useEffect(() => {
    if (!sidebarOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  const context: ShellContext = { status, error, reloadStatus };

  return (
    <div className="app">
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      <div
        className={`sidebar-scrim${sidebarOpen ? " is-open" : ""}`}
        aria-hidden="true"
        onClick={() => setSidebarOpen(false)}
      />

      <Sidebar
        status={status}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onRetryStatus={reloadStatus}
      />

      <div className="workspace">
        <TopBar
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
          status={status}
          onRetryStatus={reloadStatus}
        />
        <main id="content" tabIndex={-1}>
          {error !== null && (
            <div className="banner banner-error" role="alert">
              <div>
                <strong>Cannot reach game-cat. Is the server still running?</strong>
                <p>{error}</p>
              </div>
              <button type="button" className="button" onClick={reloadStatus}>
                Retry connection
              </button>
            </div>
          )}
          <Outlet context={context} />
        </main>
      </div>

      {/*
        Modal dialog slot for Game detail and later dialogs. It is present from
        the shell so focus trapping and route-over-dialog behavior have a stable
        home. It stays closed until a view opens it.
      */}
      <dialog className="dialog-slot" aria-label="Game detail" />
    </div>
  );
}
