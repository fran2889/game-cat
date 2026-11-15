import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { GamesResponse } from "../../shared/types.ts";
import { ApiError, fetchGames, startLibraryScan } from "../api.ts";
import { useBrowse } from "../browse-context.tsx";
import { GameResults } from "../components/GameResults.tsx";
import { OwnershipBanner } from "../components/OwnershipBanner.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { ResultsHeader } from "../components/ResultsHeader.tsx";
import { SelectionBar } from "../components/SelectionBar.tsx";
import { useToast } from "../components/ToastProvider.tsx";
import { formatTimestamp } from "../format.ts";
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
  const { status, error: statusError, reloadStatus } = useOutletContext<ShellContext>();
  const { showToast } = useToast();
  const {
    search,
    clearSearch,
    sort,
    order,
    installedOnly,
    layout,
    selectedCount,
    isSelected,
    selectShown,
    clearSelection,
  } = useBrowse();
  const [games, setGames] = useState<GamesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [scanning, setScanning] = useState(false);

  const installedFilter = mode === "installed" || installedOnly;

  const load = useCallback(
    (signal?: AbortSignal) => {
      return fetchGames(
        {
          page,
          pageSize: PAGE_SIZE,
          sort,
          order,
          ...(search.trim() === "" ? {} : { search }),
          ...(installedFilter ? { installed: true } : {}),
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
    [installedFilter, order, page, search, sort],
  );

  useEffect(() => {
    setPage(1);
  }, [search, sort, order, installedFilter, layout, mode]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, status?.lastRefresh?.finishedAt]);

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

  if (status === null) {
    // AppShell already shows the disconnected banner when the status fetch fails.
    return statusError === null ? <LoadingGrid /> : null;
  }

  if (games === null && error === null) {
    return <LoadingGrid />;
  }

  const steamRoot = status.steam.root;
  const steamMissing = status.steam.state === "not_found";
  const noAccount = status.steam.state === "no_account";
  const totalItems = games?.pagination.totalItems ?? 0;
  const totalPages = games?.pagination.totalPages ?? 0;
  const dataAsOf = games?.meta.dataAsOf ?? null;
  const rows = games?.data ?? [];
  const filtered = search.trim() !== "" || installedFilter;
  const allShownSelected = rows.length > 0 && rows.every((game) => isSelected(game.appId));

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

  if (steamMissing && rows.length === 0 && search.trim() === "") {
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

  if (error !== null && games === null) {
    return <DisconnectedBanner message={error} onRetry={() => void load()} />;
  }

  const banners = (
    <>
      {error !== null && <DisconnectedBanner message={error} onRetry={() => void load()} />}
      {noAccount && <NoAccountBanner />}
      {status !== null && <OwnershipBanner status={status} />}
    </>
  );

  if (rows.length === 0) {
    if (search.trim() !== "") {
      return (
        <section className="library" aria-label="Search results">
          {banners}
          {selectedCount > 0 && <SelectionBar />}
          <section className="empty-library" role="status" aria-labelledby="no-results-heading">
            <h2 id="no-results-heading">No games match &quot;{search}&quot;.</h2>
            <p>Search looks at game names only. Tags, genres, and playtime belong in Rules.</p>
            <div className="empty-actions">
              <button type="button" className="button" onClick={clearSearch}>
                Clear search
              </button>
            </div>
          </section>
        </section>
      );
    }

    const heading = mode === "installed" ? "No installed games found." : "No games found.";
    return (
      <section
        className="library"
        aria-label={mode === "installed" ? "Installed games" : "All games"}
      >
        {banners}
        {selectedCount > 0 && <SelectionBar />}
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
      </section>
    );
  }

  return (
    <section
      className="library"
      aria-label={mode === "installed" ? "Installed games" : "All games"}
    >
      {banners}
      <SelectionBar />
      <ResultsHeader
        totalItems={totalItems}
        shownItems={rows.length}
        filtered={filtered}
        allShownSelected={allShownSelected}
        hasGames={rows.length > 0}
        selectionCount={selectedCount}
        onSelectShown={() => selectShown(rows.map((game) => game.appId))}
        onClearSelection={clearSelection}
      />
      <GameResults games={rows} />
      {totalItems > 0 && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          totalItems={totalItems}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      )}
      {dataAsOf !== null && (
        <footer className="results-footer">
          Data as of <time dateTime={dataAsOf}>{formatTimestamp(dataAsOf)}</time>
        </footer>
      )}
    </section>
  );
}

function DisconnectedBanner({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="banner banner-error" role="alert">
      <div>
        <strong>Cannot reach game-cat. Is the server still running?</strong>
        <p>{message}</p>
      </div>
      <button type="button" className="button" onClick={onRetry}>
        Retry connection
      </button>
    </div>
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
