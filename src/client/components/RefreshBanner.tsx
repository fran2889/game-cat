import { Link } from "react-router-dom";
import type { RefreshRun, Status } from "../../shared/types.ts";
import { useRefresh } from "../refresh-context.tsx";
import { METADATA_SOURCE_LABELS, refreshModeLabel, refreshPhaseFromStatus } from "../refresh.ts";
import { formatCount } from "../format.ts";

/**
 * The running banner, plus the persistent banner for a partial or failed run
 * (§7.7). It never blocks the Library: it sits above cached content and offers
 * no cancel action because v1 has no run cancellation.
 */
export function RefreshBanner() {
  const { status, activeRun, attentionRun, retryRun, isRunning } = useRefresh();

  if (activeRun !== null) {
    return <RunningBanner run={activeRun} status={status} />;
  }
  if (attentionRun !== null) {
    return (
      <FinishedBanner
        run={attentionRun}
        onRetry={() => void retryRun(attentionRun)}
        disabled={isRunning}
      />
    );
  }
  return null;
}

function RunningBanner({ run, status }: { run: RefreshRun; status: Status | null }) {
  const phase = refreshPhaseFromStatus(run, status);
  const total = run.total;
  const done = run.done;
  const percent = total !== null && total > 0 ? Math.min(100, (done / total) * 100) : null;

  return (
    <div className="banner refresh-banner refresh-running" role="status" aria-live="polite">
      <div className="refresh-main">
        <div className="refresh-heading">
          <strong>{refreshModeLabel(run)}</strong>
          <span className="refresh-phase">{phase}</span>
          <span className="refresh-progress-text">
            {total === null ? "Working…" : `${formatCount(done)} of ${formatCount(total)}`}
          </span>
        </div>
        <div
          className={`progress${percent === null ? " progress-indeterminate" : ""}`}
          role="progressbar"
          aria-label={`${refreshModeLabel(run)} progress`}
          aria-valuemin={0}
          aria-valuemax={total ?? undefined}
          aria-valuenow={total === null ? undefined : done}
        >
          <span style={percent === null ? undefined : { width: `${percent}%` }} />
        </div>
        {run.stats !== null && (
          <div className="chip-row refresh-sources">
            {(["steamspy", "storefront", "steam_reviews"] as const).map((name) => {
              const counters = run.stats?.sources[name];
              if (counters === undefined) {
                return null;
              }
              return (
                <span className="chip refresh-chip" key={name}>
                  <strong>{METADATA_SOURCE_LABELS[name]}</strong>
                  <span>
                    {formatCount(counters.done)}/{formatCount(counters.candidates)}
                  </span>
                  {counters.skipped > 0 && (
                    <span className="refresh-chip-skipped">
                      {formatCount(counters.skipped)} skipped
                    </span>
                  )}
                  {counters.failed > 0 && (
                    <span className="refresh-chip-failed">
                      {formatCount(counters.failed)} failed
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
        <p className="refresh-note">The Library stays usable while this runs.</p>
      </div>
      <div className="banner-actions">
        <Link to="/errors" className="button">
          View refresh errors
        </Link>
      </div>
    </div>
  );
}

function FinishedBanner({
  run,
  onRetry,
  disabled,
}: {
  run: RefreshRun;
  onRetry(): void;
  disabled: boolean;
}) {
  const failed = run.status === "failed";
  const generic = "Fetch finished with some work incomplete.";
  const interrupted = run.error?.code === "INTERRUPTED";

  return (
    <div
      className={`banner refresh-banner ${failed ? "banner-error" : "banner-warning"}`}
      role={failed ? "alert" : "status"}
    >
      <div className="refresh-main">
        <div className="refresh-heading">
          <strong>{failed ? "Fetch failed" : "Fetch finished with some work incomplete."}</strong>
          {run.error !== null && <span className="refresh-error-code">{run.error.code}</span>}
        </div>
        {run.error !== null ? <p>{run.error.message}</p> : <p>{generic}</p>}
        {interrupted && (
          <p>The next Fetch resumes pending work. Nothing that finished was rolled back.</p>
        )}
      </div>
      <div className="banner-actions">
        <Link to="/errors" className="button">
          View refresh errors
        </Link>
        <button type="button" className="button" onClick={onRetry} disabled={disabled}>
          Retry
        </button>
      </div>
    </div>
  );
}
