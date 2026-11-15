import { useCallback, useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import type { Status } from "../shared/types.ts";
import { fetchStatus } from "./api.ts";
import { AppShell } from "./components/AppShell.tsx";
import { ToastProvider } from "./components/ToastProvider.tsx";
import { LibraryView } from "./views/LibraryView.tsx";
import { NotFoundView } from "./views/NotFoundView.tsx";
import { PlaceholderView } from "./views/PlaceholderView.tsx";

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <Routes>
        <Route element={<AppShell status={status} error={error} reloadStatus={reloadStatus} />}>
          <Route index element={<LibraryView mode="all" />} />
          <Route path="installed" element={<LibraryView mode="installed" />} />
          <Route
            path="smart/new"
            element={
              <PlaceholderView
                kicker="Smart collections"
                title="New Smart Collection"
                description="The Rule editor arrives with the Smart Collection slice. This route is reserved so navigation and deep links already work."
              />
            }
          />
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
          <Route
            path="steam/:id"
            element={
              <PlaceholderView
                kicker="Steam collections"
                title="Steam Collection"
                description="Steam Collections are read-only in v1. The mirrored list arrives with the local scan."
              />
            }
          />
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
            path="games/:appId"
            element={
              <PlaceholderView
                kicker="Library"
                title="Game detail"
                description="Game detail opens in the dialog slot. The full detail view arrives with the Library UI slice."
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
                  <li>Find the Steam folder. The server stays available when Steam is missing.</li>
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
    </ToastProvider>
  );
}
