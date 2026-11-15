import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { GameDetail } from "../../shared/types.ts";
import { ApiError, fetchGameDetail } from "../api.ts";
import {
  dash,
  formatBytes,
  formatCount,
  formatDate,
  formatPlaytime,
  formatTimestamp,
  ownershipLabel,
  platformLabels,
  reviewSummaryLabel,
  reviewTone,
} from "../format.ts";
import { GameCover } from "./GameCover.tsx";
import { useToast } from "./ToastProvider.tsx";

export interface DetailBackground {
  pathname: string;
  search: string;
  hash: string;
}

export interface GameDetailDialogProps {
  appId: string;
  background: DetailBackground;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; detail: GameDetail }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

function sourceStatusLabel(
  source: "tags" | "store" | "review",
  status: string,
  detail: GameDetail,
): string {
  if (source === "store" && status === "unavailable") {
    return "Not available on the store";
  }
  if (source === "review" && detail.reviewCount === 0) {
    return "No user reviews";
  }
  if (source === "review" && detail.reviewScore === null && status !== "ok") {
    return "Reviews unavailable";
  }
  return status;
}

export function GameDetailDialog({ appId, background }: GameDetailDialogProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  const closeTo = useCallback(
    (destination: { pathname: string; search: string; hash: string }) => {
      navigate(
        { pathname: destination.pathname, search: destination.search, hash: destination.hash },
        { replace: true },
      );
    },
    [navigate],
  );

  useEffect(() => {
    const parsed = /^\d+$/.test(appId) ? Number.parseInt(appId, 10) : null;
    if (parsed === null || !Number.isSafeInteger(parsed) || parsed <= 0) {
      setState({ kind: "not_found" });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    void fetchGameDetail(parsed, controller.signal)
      .then((detail) => setState({ kind: "ready", detail }))
      .catch((error: unknown) => {
        if ((error as Error).name === "AbortError") {
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          setState({ kind: "not_found" });
          return;
        }
        setState({
          kind: "error",
          message:
            error instanceof ApiError && error.status === null
              ? "Cannot reach game-cat. Is the server still running?"
              : (error as Error).message,
        });
      });
    return () => controller.abort();
  }, [appId, reloadToken]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // A browser without showModal still renders the panel; focus is best effort.
      }
    }
    return () => {
      if (dialog.open) {
        dialog.close();
      }
      const restore = restoreFocusRef.current;
      if (restore !== null && document.contains(restore)) {
        restore.focus();
      }
    };
  }, []);

  const close = () => closeTo(background);

  const detail = state.kind === "ready" ? state.detail : null;
  const installed = detail?.installed === true;
  const reviewSummary = (() => {
    if (detail === null) {
      return "—";
    }
    return reviewSummaryLabel(detail.reviewScore, detail.reviewTier, detail.reviewCount);
  })();

  return (
    <dialog
      ref={dialogRef}
      className="detail-dialog"
      aria-label={detail?.name ?? "Game detail"}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          close();
        }
      }}
    >
      <section className="detail-panel" aria-labelledby="detail-title">
        <button
          type="button"
          className="icon-button detail-close"
          aria-label="Close game detail"
          onClick={close}
        >
          ×
        </button>

        {state.kind === "loading" && (
          <div className="detail-loading" aria-busy="true" aria-label="Loading game detail">
            <div className="skeleton-cover detail-skeleton-cover" />
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
          </div>
        )}

        {state.kind === "not_found" && (
          <div className="detail-state" role="status">
            <p className="placeholder-kicker">Library</p>
            <h2 id="detail-title">Not found</h2>
            <p>That Game does not exist in this Library. Check the address, or return to it.</p>
            <Link
              to="/"
              className="primary"
              onClick={(event) => {
                event.preventDefault();
                closeTo({ pathname: "/", search: "", hash: "" });
              }}
            >
              Back to Library
            </Link>
          </div>
        )}

        {state.kind === "error" && (
          <div className="detail-state" role="alert">
            <h2 id="detail-title">Cannot load this Game</h2>
            <p>{state.message}</p>
            <button
              type="button"
              className="button"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              Retry
            </button>
          </div>
        )}

        {detail !== null && (
          <>
            <div className="detail-banner">
              <GameCover appId={detail.appId} name={detail.name} className="detail-cover" />
              <div className="detail-banner-text">
                <h2 id="detail-title">{detail.name}</h2>
                <div className="detail-badges">
                  <span className={`badge ${installed ? "is-good" : ""}`}>
                    {detail.installed === true
                      ? "Installed"
                      : detail.installed === false
                        ? "Not installed"
                        : "Install unknown"}
                  </span>
                  <span
                    className={`badge ${detail.ownershipStatus === "owned" ? "is-good" : "is-warn"}`}
                  >
                    {ownershipLabel(detail.ownershipStatus)}
                  </span>
                  <span className="badge">App {detail.appId}</span>
                </div>
              </div>
            </div>

            <div className="detail-scroll" tabIndex={0} aria-label="Game details">
              <div className="stat-grid">
                <Stat label="Playtime" value={formatPlaytime(detail.playtimeMinutes)} />
                <Stat label="Last played" value={formatDate(detail.lastPlayedAt)} />
                <Stat label="Released" value={dash(detail.releaseDateRaw ?? detail.releaseYear)} />
                <Stat label="Metacritic" value={dash(detail.metacriticScore)} />
                <Stat label="Review" value={reviewSummary} tone={reviewTone(detail.reviewScore)} />
                <Stat label="Type" value={dash(detail.type)} />
                <Stat
                  label="Platforms"
                  value={platformLabels(detail.platforms).join(", ") || "—"}
                />
                <Stat label="Size on disk" value={formatBytes(detail.sizeOnDiskBytes)} />
              </div>

              <DetailSection title="Genres">
                <ChipRow values={detail.genres} />
              </DetailSection>
              <DetailSection title="Storefront Categories">
                <ChipRow values={detail.categories} />
              </DetailSection>
              <DetailSection title="Developers">
                <ChipRow values={detail.developers} />
              </DetailSection>
              <DetailSection title="Publishers">
                <ChipRow values={detail.publishers} />
              </DetailSection>

              <DetailSection title="Tags · SteamSpy votes">
                {detail.tags.length === 0 ? (
                  <p>No tags yet</p>
                ) : (
                  <div className="tag-row">
                    {detail.tags.map((tag) => (
                      <span className="tag-chip" key={tag.name}>
                        {tag.name}
                        <span className="votes">{formatCount(tag.votes)}</span>
                      </span>
                    ))}
                  </div>
                )}
              </DetailSection>

              <DetailSection title="Steam Collections">
                {detail.steamCollections.length === 0 ? (
                  <p>—</p>
                ) : (
                  <div className="chip-row">
                    {detail.steamCollections.map((collection) => (
                      <span className="chip" key={collection.id}>
                        {collection.name}
                      </span>
                    ))}
                  </div>
                )}
              </DetailSection>

              <DetailSection title="Metadata status">
                <div className="source-list">
                  {(
                    [
                      ["Tags", "tags", detail.metadata.tagsStatus, detail.metadata.tagsFetchedAt],
                      [
                        "Storefront",
                        "store",
                        detail.metadata.storeStatus,
                        detail.metadata.storeFetchedAt,
                      ],
                      [
                        "Reviews",
                        "review",
                        detail.metadata.reviewStatus,
                        detail.metadata.reviewFetchedAt,
                      ],
                    ] as const
                  ).map(([label, source, status, fetchedAt]) => (
                    <span key={label}>
                      <span aria-hidden="true">●</span>
                      <strong>{label}:</strong> {sourceStatusLabel(source, status, detail)}
                      {fetchedAt !== null && fetchedAt !== undefined && (
                        <span className="source-time"> · {formatTimestamp(fetchedAt)}</span>
                      )}
                    </span>
                  ))}
                </div>
              </DetailSection>
            </div>

            <p className="launch-note">
              Launch opens the game through Steam. game-cat never writes Steam files; the store link
              is safe.
            </p>
            <div className="detail-actions">
              <a
                className="primary"
                href={`https://store.steampowered.com/app/${detail.appId}/`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on Steam Store
              </a>
              {installed ? (
                <a
                  className="button"
                  href={`steam://rungameid/${detail.appId}`}
                  onClick={() => showToast("Opening Steam…")}
                >
                  Launch
                </a>
              ) : (
                <button
                  type="button"
                  className="button"
                  disabled
                  title="Install the game in Steam to launch it."
                >
                  Launch
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone === undefined ? "" : ` review-text ${tone}`}`}>{value}</div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="detail-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function ChipRow({ values }: { values: string[] }) {
  if (values.length === 0) {
    return <p>—</p>;
  }
  return (
    <div className="chip-row">
      {values.map((value) => (
        <span className="chip" key={value}>
          {value}
        </span>
      ))}
    </div>
  );
}
