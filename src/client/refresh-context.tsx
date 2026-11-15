import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { RefreshRun, Status } from "../shared/types.ts";
import { ApiError, fetchStatus, startRefresh, type RefreshRequestBody } from "./api.ts";
import { useToast } from "./components/ToastProvider.tsx";
import { isRunningStatus, isTerminalStatus, refreshRequestFor } from "./refresh.ts";

const POLL_INTERVAL_MS = 800;

interface RefreshContextValue {
  status: Status | null;
  /** The run whose progress the banner should show, if any. */
  activeRun: RefreshRun | null;
  /** A terminal partial or failed run that keeps a persistent banner. */
  attentionRun: RefreshRun | null;
  isRunning: boolean;
  starting: boolean;
  startFetch(): Promise<void>;
  startOwnershipRetry(): Promise<void>;
  retryRun(run: RefreshRun): Promise<void>;
  startRun(body: RefreshRequestBody): Promise<RefreshRun | null>;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

export interface RefreshProviderProps {
  status: Status | null;
  applyStatus(status: Status): void;
  children: ReactNode;
}

/**
 * Refresh state shared by the shell, the Library, and `/errors`.
 *
 * The server is the source of truth. While a run is queued or running the
 * provider polls `GET /api/status`, so progress, phase, source chips, and the
 * point at which the run becomes terminal all come from the documented
 * `activeRefresh` / `lastRefresh` shapes. Polling stops at the terminal state.
 */
export function RefreshProvider({
  status,
  applyStatus,
  children,
}: RefreshProviderProps): ReactElement {
  const { showToast } = useToast();
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const [pendingRun, setPendingRun] = useState<RefreshRun | null>(null);
  const [starting, setStarting] = useState(false);
  const completionHandled = useRef<Set<string>>(new Set());

  const activeFromStatus = status?.activeRefresh ?? null;

  // Adopt a run that was already active when the page loaded (for example the
  // startup Fetch) so the banner and progress polling start immediately.
  useEffect(() => {
    if (activeFromStatus !== null) {
      setTrackedId(activeFromStatus.id);
    }
  }, [activeFromStatus?.id]);

  // Drop the optimistic run once the status document reflects it.
  useEffect(() => {
    if (pendingRun === null) {
      return;
    }
    const reflected =
      status?.activeRefresh?.id === pendingRun.id ||
      (status?.lastRefresh?.id === pendingRun.id && isTerminalStatus(status.lastRefresh.status));
    if (reflected) {
      setPendingRun(null);
    }
  }, [pendingRun, status]);

  // Poll while a run is active. Polling stops when the run becomes terminal.
  useEffect(() => {
    if (trackedId === null) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const next = await fetchStatus();
        if (!cancelled) {
          applyStatus(next);
        }
      } catch {
        // The shell already shows the disconnected banner and Retry connection.
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(() => void poll(), 250);
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [applyStatus, trackedId]);

  // Once the tracked run reaches a terminal state, stop polling and announce a
  // successful Fetch. Partial and failed runs keep their persistent banner.
  useEffect(() => {
    if (trackedId === null || activeFromStatus !== null) {
      return;
    }
    const last = status?.lastRefresh;
    if (last === null || last === undefined || last.id !== trackedId) {
      return;
    }
    if (!isTerminalStatus(last.status)) {
      return;
    }
    setTrackedId(null);
    if (last.status === "succeeded" && !completionHandled.current.has(last.id)) {
      completionHandled.current.add(last.id);
      showToast("Library up to date");
    }
  }, [activeFromStatus, showToast, status, trackedId]);

  const startRun = useCallback(
    async (body: RefreshRequestBody): Promise<RefreshRun | null> => {
      setStarting(true);
      try {
        const run = await startRefresh(body);
        setPendingRun(isRunningStatus(run.status) ? run : null);
        setTrackedId(run.id);
        return run;
      } catch (error) {
        if (error instanceof ApiError && error.code === "REFRESH_IN_PROGRESS") {
          // Pick up the conflicting run so its banner is shown instead.
          try {
            applyStatus(await fetchStatus());
          } catch {
            // Keep the toast below as the user-facing failure.
          }
        }
        showToast(error instanceof ApiError ? error.message : "The Fetch could not be started.");
        return null;
      } finally {
        setStarting(false);
      }
    },
    [applyStatus, showToast],
  );

  const startFetch = useCallback(async (): Promise<void> => {
    await startRun({ scope: "all", mode: "fetch" });
  }, [startRun]);

  const startOwnershipRetry = useCallback(async (): Promise<void> => {
    await startRun({ scope: "ownership" });
  }, [startRun]);

  const retryRun = useCallback(
    async (run: RefreshRun): Promise<void> => {
      await startRun(refreshRequestFor(run));
    },
    [startRun],
  );

  const activeRun = activeFromStatus ?? (pendingRun !== null ? pendingRun : null);
  // Only a Fetch/Full Refresh gets the persistent run banner. Library and
  // ownership failures already have their own documented surfaces.
  const last = status?.lastRefresh ?? null;
  const attentionRun =
    activeRun === null &&
    last !== null &&
    (last.scope === "all" || last.scope === "metadata") &&
    isTerminalStatus(last.status) &&
    last.status !== "succeeded"
      ? last
      : null;

  const value = useMemo<RefreshContextValue>(
    () => ({
      status,
      activeRun,
      attentionRun,
      isRunning: activeRun !== null || starting,
      starting,
      startFetch,
      startOwnershipRetry,
      retryRun,
      startRun,
    }),
    [
      activeRun,
      attentionRun,
      startFetch,
      startOwnershipRetry,
      retryRun,
      startRun,
      starting,
      status,
    ],
  );

  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): RefreshContextValue {
  const value = useContext(RefreshContext);
  if (value === null) {
    throw new Error("useRefresh must be used inside RefreshProvider");
  }
  return value;
}
