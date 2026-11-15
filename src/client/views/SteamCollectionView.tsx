import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SteamCollectionGamesResponse, SteamCollectionSummary } from "../../shared/types.ts";
import { ApiError, fetchSteamCollection, fetchSteamCollectionGames } from "../api.ts";
import { useBrowse } from "../browse-context.tsx";
import { GameResults } from "../components/GameResults.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { ResultsHeader } from "../components/ResultsHeader.tsx";
import { SelectionBar } from "../components/SelectionBar.tsx";
import { formatTimestamp } from "../format.ts";

const PAGE_SIZE = 60;

function LoadingCollection() {
  return (
    <section className="library-loading" aria-busy="true" aria-label="Loading the Steam Collection">
      <div className="skeleton-grid">
        {Array.from({ length: 4 }, (_, index) => (
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

function kindLabel(kind: SteamCollectionSummary["kind"]): string {
  switch (kind) {
    case "favorite":
      return "Favorites";
    case "hidden":
      return "Hidden";
    case "user":
      return "User Collection";
    case "tag":
      return "Tag snapshot";
    case "system":
      return "Steam system Collection";
    default:
      return "Steam Collection";
  }
}

export function SteamCollectionView() {
  const { id = "" } = useParams();
  const { sort, order, layout, selectedCount, isSelected, selectShown, clearSelection } =
    useBrowse();
  const [summary, setSummary] = useState<SteamCollectionSummary | null>(null);
  const [members, setMembers] = useState<SteamCollectionGamesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setSummary(null);
    setMembers(null);
    setError(null);
    setMissing(false);
    setPage(1);
  }, [id]);

  useEffect(() => {
    if (id === "") {
      setMissing(true);
      return;
    }
    const controller = new AbortController();
    void fetchSteamCollection(id, controller.signal)
      .then((next) => {
        setSummary(next);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if ((fetchError as Error).name === "AbortError") {
          return;
        }
        if (fetchError instanceof ApiError && fetchError.status === 404) {
          setMissing(true);
        } else {
          setError((fetchError as Error).message);
        }
      });
    return () => controller.abort();
  }, [id]);

  useEffect(() => {
    setPage(1);
  }, [sort, order, layout]);

  const loadMembers = useCallback(
    (signal?: AbortSignal) => {
      if (id === "") {
        return;
      }
      void fetchSteamCollectionGames(id, { page, pageSize: PAGE_SIZE, sort, order }, signal)
        .then((next) => {
          setMembers(next);
          setError(null);
        })
        .catch((fetchError: unknown) => {
          if ((fetchError as Error).name === "AbortError") {
            return;
          }
          if (fetchError instanceof ApiError && fetchError.status === 404) {
            setMissing(true);
          } else {
            setError((fetchError as Error).message);
          }
        });
    },
    [id, order, page, sort],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadMembers(controller.signal);
    return () => controller.abort();
  }, [loadMembers]);

  if (missing) {
    return (
      <section className="empty-library" aria-labelledby="steam-collection-missing">
        <h2 id="steam-collection-missing">Steam Collection not found.</h2>
        <p>
          It is not in the current Steam Collection mirror. It may have been deleted in Steam before
          the last scan.
        </p>
        <div className="empty-actions">
          <Link to="/" className="button">
            Back to the Library
          </Link>
        </div>
      </section>
    );
  }

  if (error !== null) {
    return (
      <div className="banner banner-error" role="alert">
        <div>
          <strong>Cannot load this Steam Collection.</strong>
          <p>{error}</p>
        </div>
        <button type="button" className="button" onClick={() => loadMembers()}>
          Retry
        </button>
      </div>
    );
  }

  if (summary === null) {
    return <LoadingCollection />;
  }

  const header = (
    <header className="collection-header">
      <div>
        <p className="placeholder-kicker">Steam collections</p>
        <h2 id="collection-heading">{summary.name}</h2>
        <p className="collection-meta">
          <span className="pill">
            <span aria-hidden="true">🔒</span> Read-only mirror · never written back
          </span>
          <span>{kindLabel(summary.kind)}</span>
          {summary.isDynamic && <span className="pill">Dynamic</span>}
        </p>
      </div>
    </header>
  );

  if (summary.isDynamic) {
    return (
      <section className="library" aria-labelledby="collection-heading">
        {header}
        <section className="placeholder" aria-labelledby="dynamic-collection-heading">
          <h2 id="dynamic-collection-heading">Steam computes this Collection</h2>
          <p>
            Steam computes this Collection&apos;s membership. game-cat treats dynamic Collections as
            opaque metadata in v1.
          </p>
          <p>
            There is no stored member list and no game count, and this Collection never contributes
            matches to the steamCollection Rule Field.
          </p>
        </section>
      </section>
    );
  }

  const totalItems = members?.pagination.totalItems ?? summary.gameCount ?? 0;
  const totalPages = members?.pagination.totalPages ?? 0;
  const dataAsOf = members?.meta.dataAsOf ?? null;
  const rows = members?.data ?? [];
  const allShownSelected = rows.length > 0 && rows.every((game) => isSelected(game.appId));

  if (members === null) {
    return (
      <section className="library" aria-labelledby="collection-heading">
        {header}
        <LoadingCollection />
      </section>
    );
  }

  return (
    <section className="library" aria-labelledby="collection-heading">
      {header}

      {totalItems === 0 ? (
        <>
          {selectedCount > 0 && <SelectionBar />}
          <section className="empty-library" aria-labelledby="empty-collection-heading">
            <h2 id="empty-collection-heading">This Steam Collection is empty</h2>
            <p>Steam returned no static members for this Collection.</p>
          </section>
        </>
      ) : (
        <>
          <SelectionBar />
          <ResultsHeader
            totalItems={totalItems}
            shownItems={rows.length}
            filtered={false}
            allShownSelected={allShownSelected}
            hasGames={rows.length > 0}
            selectionCount={selectedCount}
            onSelectShown={() => selectShown(rows.map((game) => game.appId))}
            onClearSelection={clearSelection}
          />
          <GameResults games={rows} />
          {totalPages > 0 && (
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
        </>
      )}
    </section>
  );
}
