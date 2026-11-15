import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, matchPath, useLocation } from "react-router-dom";
import type { Config, Status } from "../shared/types.ts";
import { fetchConfig, fetchStatus } from "./api.ts";
import { BrowseProvider } from "./browse-context.tsx";
import { viewKindForPath } from "./browse.ts";
import { AppShell } from "./components/AppShell.tsx";
import { GameDetailDialog, type DetailBackground } from "./components/GameDetailDialog.tsx";
import { ToastProvider } from "./components/ToastProvider.tsx";
import { LibraryView } from "./views/LibraryView.tsx";
import { NotFoundView } from "./views/NotFoundView.tsx";
import { OnboardingView } from "./views/OnboardingView.tsx";
import { PlaceholderView } from "./views/PlaceholderView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
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
  const [config, setConfig] = useState<Config | null>(null);
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

  const reloadConfig = useCallback(() => {
    const controller = new AbortController();
    void fetchConfig(controller.signal)
      .then((next) => setConfig(next))
      .catch((fetchError: unknown) => {
        if ((fetchError as Error).name !== "AbortError") {
          setError((fetchError as Error).message);
        }
      });
    return () => controller.abort();
  }, []);

  const applyConfig = useCallback((next: Config) => {
    setConfig(next);
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

  useEffect(() => {
    const controller = new AbortController();
    void fetchConfig(controller.signal)
      .then((next) => setConfig(next))
      .catch((fetchError: unknown) => {
        if ((fetchError as Error).name !== "AbortError") {
          setError((fetchError as Error).message);
        }
      });
    return () => controller.abort();
  }, []);

  const needsOnboarding =
    config !== null && !config.steamApiKeySet && config.steamApiKeySource === "none";

  if (needsOnboarding && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <ToastProvider>
      <BrowseProvider viewKind={viewKindForPath(routeLocation.pathname)}>
        <Routes location={routeLocation}>
          <Route
            element={
              <AppShell
                status={status}
                config={config}
                error={error}
                reloadStatus={reloadStatus}
                reloadConfig={reloadConfig}
                applyConfig={applyConfig}
              />
            }
          >
            <Route index element={<LibraryView mode="all" />} />
            <Route path="installed" element={<LibraryView mode="installed" />} />
            <Route path="smart/new" element={<SmartNewView />} />
            <Route path="smart/:id" element={<PlaceholderSmartView />} />
            <Route path="steam/:id" element={<SteamCollectionView />} />
            <Route path="errors" element={<PlaceholderErrorsView />} />
            <Route path="onboarding" element={<OnboardingView />} />
            <Route path="settings" element={<SettingsView />} />
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

function PlaceholderSmartView() {
  return (
    <PlaceholderView
      kicker="Smart collections"
      title="Smart Collection"
      description="Saved Smart Collections and their live match counts arrive with the Rule evaluator."
    />
  );
}

function PlaceholderErrorsView() {
  return (
    <PlaceholderView
      kicker="Refresh"
      title="Refresh errors"
      description="Source health will be listed here once Refresh runs exist. The status endpoint already reports the five source rows."
    />
  );
}
