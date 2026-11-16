import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes, matchPath, useLocation } from "react-router-dom";
import type { Config, Status } from "../shared/types.ts";
import { configQueryKey, configQueryOptions, statusQueryKey, statusQueryOptions } from "./api.ts";
import { BrowseProvider } from "./browse-context.tsx";
import { viewKindForPath } from "./browse.ts";
import { AppShell } from "./components/AppShell.tsx";
import { GameDetailDialog, type DetailBackground } from "./components/GameDetailDialog.tsx";
import { ToastProvider } from "./components/ToastProvider.tsx";
import { ErrorsView } from "./views/ErrorsView.tsx";
import { LibraryView } from "./views/LibraryView.tsx";
import { NotFoundView } from "./views/NotFoundView.tsx";
import { OnboardingView } from "./views/OnboardingView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { SmartCollectionView } from "./views/SmartCollectionView.tsx";
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
  const queryClient = useQueryClient();
  const statusQuery = useQuery(statusQueryOptions);
  const configQuery = useQuery(configQueryOptions);
  const status = statusQuery.data ?? null;
  const config = configQuery.data ?? null;
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

  useEffect(() => {
    if (statusQuery.data !== undefined) {
      setError(null);
    }
  }, [statusQuery.data]);

  useEffect(() => {
    if (statusQuery.error !== null) {
      setError((statusQuery.error as Error).message);
    }
  }, [statusQuery.error]);

  useEffect(() => {
    if (configQuery.error !== null) {
      setError((configQuery.error as Error).message);
    }
  }, [configQuery.error]);

  const reloadStatus = useCallback(() => {
    setError(null);
    void queryClient.refetchQueries({ queryKey: statusQueryKey });
  }, [queryClient]);

  const reloadConfig = useCallback(() => {
    void queryClient.refetchQueries({ queryKey: configQueryKey });
  }, [queryClient]);

  const applyConfig = useCallback(
    (next: Config) => {
      queryClient.setQueryData(configQueryKey, next);
    },
    [queryClient],
  );

  const applyStatus = useCallback(
    (next: Status) => {
      queryClient.setQueryData(statusQueryKey, next);
      setError(null);
    },
    [queryClient],
  );

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
                applyStatus={applyStatus}
              />
            }
          >
            <Route index element={<LibraryView mode="all" />} />
            <Route path="installed" element={<LibraryView mode="installed" />} />
            <Route path="smart/new" element={<SmartNewView />} />
            <Route path="smart/:id" element={<SmartCollectionView />} />
            <Route path="steam/:id" element={<SteamCollectionView />} />
            <Route path="errors" element={<ErrorsView />} />
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
