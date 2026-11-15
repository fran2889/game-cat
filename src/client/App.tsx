import { useCallback, useEffect, useState } from "react";
import { Route, Routes, matchPath, useLocation } from "react-router-dom";
import type { Status } from "../shared/types.ts";
import { fetchStatus } from "./api.ts";
import { BrowseProvider } from "./browse-context.tsx";
import { viewKindForPath } from "./browse.ts";
import { AppShell } from "./components/AppShell.tsx";
import { GameDetailDialog, type DetailBackground } from "./components/GameDetailDialog.tsx";
import { ToastProvider } from "./components/ToastProvider.tsx";
import { LibraryView } from "./views/LibraryView.tsx";
import { NotFoundView } from "./views/NotFoundView.tsx";
import { PlaceholderView } from "./views/PlaceholderView.tsx";
import { SmartNewView } from "./views/SmartNewView.tsx";
import { SteamCollectionView } from "./views/SteamCollectionView.tsx";

interface DetailState {
  backgroundLocation?: {
    pathname?: unknown;
    search?: unknown;
    hash?: unknown;
  };
}

function backgroundFor(location: ReturnType<typeof useLocation>): DetailBackground | null {
  const state = location.state as DetailState | null;
  const background = state?.backgroundLocation;
  if (background !== undefined && background !== null && typeof background.pathname === "string") {
    return {
      pathname: background.pathname,
      search: typeof background.search === "string" ? background.search : "",
      hash: typeof background.hash === "string" ? background.hash : "",
    };
  }
  return null;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  const gameMatch = matchPath("/games/:appId", location.pathname);
  const detailBackground =
    gameMatch === null
      ? null
      : (backgroundFor(location) ?? {
          pathname: "/",
          search: location.search,
          hash: location.hash,
        });
  const routeLocation = detailBackground ?? location;

  const reloadStatus = useCallback(() => {
    setError(null);
    const controller = new AbortController();
    void fetchStatus(controller.signal)
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if ((fetchError as Error).name !== "AbortError") {
          setError((fetchError as Error).message);
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchStatus(controller.signal)
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if ((fetchError as Error).name !== "AbortError") {
          setError((fetchError as Error).message);
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <ToastProvider>
      <BrowseProvider viewKind={viewKindForPath(routeLocation.pathname)}>
        <Routes location={routeLocation}>
          <Route element={<AppShell status={status} error={error} reloadStatus={reloadStatus} />}>
            <Route index element={<LibraryView mode="all" />} />
            <Route path="installed" element={<LibraryView mode="installed" />} />
            <Route path="smart/new" element={<SmartNewView />} />
            <Route
              path="smart/:id"
              element={
                <PlaceholderView
                  kicker="Smart collections"
                  title="Smart Collection"
                  description="Saved Smart Collections and their live match counts arrive with the Rule evaluator."
                />
              }
            />
            <Route path="steam/:id" element={<SteamCollectionView />} />
            <Route
              path="errors"
              element={
                <PlaceholderView
                  kicker="Refresh"
                  title="Refresh errors"
                  description="Source health will be listed here once Refresh runs exist. The status endpoint already reports the five source rows."
                />
              }
            />
            <Route
              path="onboarding"
              element={
                <PlaceholderView
                  kicker="Setup"
                  title="First run"
                  description="Onboarding will confirm the Steam folder, choose an Account, save the Steam Web API key, and start the first Fetch. Those steps are wired in later slices."
                >
                  <ol className="setup-list">
                    <li>
                      Find the Steam folder. The server stays available when Steam is missing.
                    </li>
                    <li>Choose one Account from loginusers.vdf.</li>
                    <li>Save a Steam Web API key to config.json.</li>
                    <li>Run the first Fetch. Pending work is visible from the Refresh card.</li>
                  </ol>
                </PlaceholderView>
              }
            />
            <Route path="*" element={<NotFoundView />} />
          </Route>
        </Routes>
        {gameMatch !== null && detailBackground !== null && (
          <GameDetailDialog appId={gameMatch.params.appId ?? ""} background={detailBackground} />
        )}
      </BrowseProvider>
    </ToastProvider>
  );
}
