import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { GamesResponse } from "../../shared/types.ts";
import { ApiError, fetchGames, startLibraryScan, startOwnershipRefresh } from "../api.ts";
import { GameCard } from "../components/GameCard.tsx";
import { OwnershipBanner } from "../components/OwnershipBanner.tsx";
import { useToast } from "../components/ToastProvider.tsx";
import type { ShellContext } from "../shell-context.ts";

export interface LibraryViewProps {
  mode: "all" | "installed";
}

const PAGE_SIZE = 60;

function LoadingGrid() {
  return (
    <section className="library-loading" aria-busy="true" aria-label="Loading the Library">
      <div className="skeleton-grid">
        {Array.from({ length: 8 }, (_, index) => (
          <div className="skeleton-card" key={index}>
            <div className="skeleton-cover" />
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function LibraryView({ mode }: LibraryViewProps) {
  const { status, reloadStatus } = useOutletContext<ShellContext>();
  const { showToast } = useToast();
  const [games, setGames] = useState<GamesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [scanning, setScanning] = useState(false);
  const [refreshingOwnership, setRefreshingOwnership] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal) => {
      return fetchGames(
        {
          page,
          pageSize: PAGE_SIZE,
          ...(mode === "installed" ? { installed: true } : {}),
        },
        signal,
      )
        .then((next) => {
          setGames(next);
          setError(null);
        })
        .catch((fetchError: unknown) => {
          if ((fetchError as Error).name !== "AbortError") {
            setError((fetchError as Error).message);
          }
        });
    },
    [mode, page],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const scan = async (): Promise<void> => {
    setScanning(true);
    try {
      const run = await startLibraryScan();
      if (run.status === "failed") {
        showToast(run.error?.message ?? "The scan failed.");
      } else if (run.status === "partial") {
        showToast("Scan finished with some Steam data unavailable.");
      } else {
        showToast("Library scan finished.");
      }
      setPage(1);
      await load();
      reloadStatus();
    } catch (scanError) {
      showToast(
        scanError instanceof ApiError ? scanError.message : "The Library scan could not start.",
      );
    } finally {
      setScanning(false);
    }
  };

  const retryOwnership = async (): Promise<void> => {
    setRefreshingOwnership(true);
    try {
      const run = await startOwnershipRefresh();
      if (run.status === "failed") {
        showToast(run.error?.message ?? "The ownership refresh failed.");
      } else if (run.status === "partial") {
        showToast("Ownership refresh finished with some Steam data unavailable.");
      } else {
        showToast("Ownership roster refreshed.");
      }
      setPage(1);
      await load();
      reloadStatus();
    } catch (ownershipError) {
      showToast(
        ownershipError instanceof ApiError
          ? ownershipError.message
          : "The ownership refresh could not start.",
      );
    } finally {
      setRefreshingOwnership(false);
    }
  };

  if (status === null || (games === null && error === null)) {
    return <LoadingGrid />;
  }

  const steamRoot = status.steam.root;
  const steamMissing = status.steam.state === "not_found";
  const noAccount = status.steam.state === "no_account";
  const totalItems = games?.pagination.totalItems ?? 0;
  const totalPages = games?.pagination.totalPages ?? 0;
  const rows = games?.data ?? [];

  const actions = (
    <div className="empty-actions">
      <button type="button" className="primary" onClick={() => void scan()} disabled={scanning}>
        {scanning ? "Scanning…" : "Scan again"}
      </button>
      <Link to="/onboarding" className="button">
        Change Steam folder
      </Link>
    </div>
  );

  if (steamMissing && rows.length === 0) {
    return (
      <section className="empty-library" aria-labelledby="steam-missing-heading">
        <div className="empty-illustration" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h2 id="steam-missing-heading">Steam was not found.</h2>
        <p>
          Install or start Steam, then scan again. A moved library, a Flatpak install, or a fresh
          Steam install can all leave the Library empty.
        </p>
        {steamRoot !== null && (
          <p className="empty-path">
            Configured Steam folder: <code>{steamRoot}</code>
          </p>
        )}
        {actions}
      </section>
    );
  }

  if (error !== null) {
    return (
      <div className="banner banner-error" role="alert">
        <div>
          <strong>Cannot reach game-cat. Is the server still running?</strong>
          <p>{error}</p>
        </div>
        <button type="button" className="button" onClick={() => void load()}>
          Retry connection
        </button>
      </div>
    );
  }

  if (rows.length === 0) {
    const heading = mode === "installed" ? "No installed games found." : "No games found.";
    return (
      <>
        {noAccount && <NoAccountBanner />}
        {status !== null && (
          <OwnershipBanner
            status={status}
            refreshing={refreshingOwnership}
            onRetry={retryOwnership}
          />
        )}
        <section className="empty-library" aria-labelledby="empty-heading">
          <div className="empty-illustration" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2 id="empty-heading">{heading}</h2>
          <p>
            {mode === "installed"
              ? "No app manifest reports an installed Game yet. Nothing has been moved or deleted."
              : "Nothing has been scanned yet, or Steam has no local Games for this Account. A moved Steam library, a Flatpak install, or a fresh Steam install can all leave this list empty."}
          </p>
          {steamRoot !== null && (
            <p className="empty-path">
              Steam root: <code>{steamRoot}</code>
            </p>
          )}
          {actions}
        </section>
      </>
    );
  }

  return (
    <section
      className="library"
      aria-label={mode === "installed" ? "Installed games" : "All games"}
    >
      {noAccount && <NoAccountBanner />}
      {status !== null && (
        <OwnershipBanner
          status={status}
          refreshing={refreshingOwnership}
          onRetry={retryOwnership}
        />
      )}
      <div className="library-summary">
        <p>
          {totalItems} {totalItems === 1 ? "game" : "games"}
        </p>
        <button type="button" className="button" onClick={() => void scan()} disabled={scanning}>
          {scanning ? "Scanning…" : "Scan again"}
        </button>
      </div>
      <div className="game-grid">
        {rows.map((game) => (
          <GameCard key={game.appId} game={game} />
        ))}
      </div>
      <nav className="pagination" aria-label="Pagination">
        <button
          type="button"
          className="button"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={page <= 1}
        >
          Previous
        </button>
        <span aria-live="polite">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="button"
          onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          disabled={page >= totalPages}
        >
          Next
        </button>
      </nav>
    </section>
  );
}

function NoAccountBanner() {
  return (
    <div className="banner banner-warning" role="status">
      <div>
        <strong>No Steam Account selected.</strong>
        <p>
          The Library still shows local data, but playtime and Steam Collections are unavailable
          until an Account is selected.
        </p>
      </div>
      <Link to="/onboarding" className="button">
        Open account picker
      </Link>
    </div>
  );
}
