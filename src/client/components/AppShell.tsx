import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import type { Config, Status } from "../../shared/types.ts";
import { RefreshProvider } from "../refresh-context.tsx";
import type { ShellContext } from "../shell-context.ts";
import { RefreshBanner } from "./RefreshBanner.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { TopBar } from "./TopBar.tsx";

export interface AppShellProps {
  status: Status | null;
  config: Config | null;
  error: string | null;
  reloadStatus(): void;
  reloadConfig(): void;
  applyConfig(config: Config): void;
  applyStatus(status: Status): void;
}

export function AppShell({
  status,
  config,
  error,
  reloadStatus,
  reloadConfig,
  applyConfig,
  applyStatus,
}: AppShellProps) {
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

  const context: ShellContext = {
    status,
    config,
    error,
    reloadStatus,
    reloadConfig,
    applyConfig,
    applyStatus,
  };

  return (
    <RefreshProvider status={status} applyStatus={applyStatus}>
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
            <RefreshBanner />
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
      </div>
    </RefreshProvider>
  );
}
