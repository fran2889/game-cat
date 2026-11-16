import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNavigate, useOutletContext } from "react-router-dom";
import { SOURCE_ORDER, type SourceHealth } from "../../shared/types.ts";
import { useBrowse } from "../browse-context.tsx";
import { formatCount, formatTimestamp } from "../format.ts";
import { useRefresh } from "../refresh-context.tsx";
import {
  fetchAffectedAndPendingGames,
  isMetadataSource,
  sourceLabel,
  sourceStatusTone,
  type AffectedAndPendingGames,
  type MetadataSource,
} from "../refresh.ts";
import type { ShellContext } from "../shell-context.ts";

const METADATA_SOURCES: readonly MetadataSource[] = ["steamspy", "storefront", "steam_reviews"];

type AffectedState = Record<MetadataSource, AffectedAndPendingGames | null>;

function emptyAffected(): AffectedState {
  return { steamspy: null, storefront: null, steam_reviews: null };
}

/**
 * `/errors` — one row per source in the documented order (§1.7, §7.7).
 *
 * Affected counts and IDs come from the documented `/api/games` status filters;
 * pending counts combine `missing` with no `*_fetched_at`. The view never
 * renders per-Game error text or upstream payloads; only the safe per-source
 * `lastError` crosses this surface.
 */
export function ErrorsView() {
  const { status } = useOutletContext<ShellContext>();
  const { isRunning, startFetch } = useRefresh();
  const { replaceSelection } = useBrowse();
  const navigate = useNavigate();
  const [selecting, setSelecting] = useState<MetadataSource | null>(null);

  const metadataKey = status === null ? "none" : JSON.stringify(status.metadata);
  const affectedQueries = useQueries({
    queries: METADATA_SOURCES.map((source) => ({
      queryKey: ["affected-and-pending", source, metadataKey],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchAffectedAndPendingGames(source, signal),
      enabled: status !== null,
    })),
  });
  const affected = emptyAffected();
  for (const [index, source] of METADATA_SOURCES.entries()) {
    const data = affectedQueries[index]?.data;
    if (data !== undefined) {
      affected[source] = data;
    }
  }
  const loadingAffected = status !== null && affectedQueries.some((query) => query.isPending);
  const affectedError = affectedQueries.some((query) => query.isError);

  const selectAffected = async (source: MetadataSource): Promise<void> => {
    const known = affected[source];
    if (known === null || known.affectedCount === 0) {
      return;
    }
    setSelecting(source);
    try {
      replaceSelection(known.affectedIds);
      navigate("/");
    } finally {
      setSelecting(null);
    }
  };

  if (status === null) {
    return (
      <section className="errors-view" aria-labelledby="errors-heading">
        <h2 id="errors-heading">Refresh errors</h2>
        <p>Cannot reach game-cat. Is the server still running?</p>
      </section>
    );
  }

  const byName = new Map(status.sources.map((source) => [source.name, source]));
  const sources = SOURCE_ORDER.map((name) => byName.get(name)).filter(
    (source): source is SourceHealth => source !== undefined,
  );

  return (
    <section className="errors-view" aria-labelledby="errors-heading">
      <header className="errors-head">
        <div>
          <h2 id="errors-heading">Refresh errors</h2>
          <p>
            Per-source health for the five Refresh sources. Affected Games have a failed last
            attempt; pending Games have not been attempted yet. The Library stays usable with cached
            data while a source recovers.
          </p>
        </div>
        <button
          type="button"
          className="primary"
          onClick={() => void startFetch()}
          disabled={isRunning}
        >
          Fetch
        </button>
      </header>

      <ul className="errors-list">
        {sources.map((source) => {
          const tone = sourceStatusTone(source.status);
          const metadataName = isMetadataSource(source.name) ? source.name : null;
          const metadata = metadataName !== null;
          const affectedEntry = metadataName === null ? null : affected[metadataName];
          const count = affectedEntry === null ? null : affectedEntry.affectedCount;
          const pendingCount = affectedEntry?.pendingCount ?? 0;
          const canSelect =
            metadataName !== null &&
            affectedEntry !== null &&
            affectedEntry.affectedCount > 0 &&
            !loadingAffected &&
            !affectedError;
          return (
            <li key={source.name} className={`error-row tone-${tone}`} data-source={source.name}>
              <div className="error-source">
                <strong>{sourceLabel(source)}</strong>
                <span className={`status-pill tone-${tone}`}>{source.status}</span>
              </div>

              <dl className="error-times">
                <div>
                  <dt>Last success</dt>
                  <dd>{formatTimestamp(source.lastSuccessAt)}</dd>
                </div>
                <div>
                  <dt>Last attempt</dt>
                  <dd>{formatTimestamp(source.lastAttemptAt)}</dd>
                </div>
                {source.retryAfterAt !== null && (
                  <div>
                    <dt>Retry after</dt>
                    <dd>{formatTimestamp(source.retryAfterAt)}</dd>
                  </div>
                )}
              </dl>

              <div className="error-detail">
                <p className="error-message">{source.lastError ?? "No recent error."}</p>
                {metadata && (
                  <p className="affected-count">
                    {loadingAffected
                      ? "Counting affected Games…"
                      : affectedError
                        ? "Affected Games could not be counted."
                        : `${formatCount(count ?? 0)} affected ${
                            count === 1 ? "Game" : "Games"
                          } · ${formatCount(pendingCount)} pending`}
                  </p>
                )}
              </div>

              {metadata && (
                <div className="error-actions">
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => void startFetch()}
                    disabled={isRunning}
                  >
                    Fetch now
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => metadataName !== null && void selectAffected(metadataName)}
                    disabled={!canSelect || selecting !== null}
                    title={
                      !canSelect && !loadingAffected && !affectedError
                        ? "No affected Games for this source."
                        : undefined
                    }
                  >
                    Select affected
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
