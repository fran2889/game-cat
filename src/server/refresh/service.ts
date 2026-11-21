import type BetterSqlite3 from "better-sqlite3";
import type { RefreshMode, RefreshRun, RefreshScope } from "../../shared/types.ts";
import { MAX_REFRESH_APP_IDS } from "../../shared/types.ts";
import { readBoundSteamId64 } from "../db/database.ts";
import { HttpError } from "../errors.ts";
import { validationError } from "../request.ts";
import type { scanLocalLibrary } from "../library/scan.ts";
import type { SteamOwnershipSource } from "../steam/ownership.ts";
import { executeMetadataPhase, type MetadataPhaseOptions } from "./metadata-phase.ts";
import { performLibraryPhase, type LibraryPhaseOptions } from "./library-phase.ts";
import { performOwnershipPhase, type OwnershipPhaseOptions } from "./ownership-phase.ts";
import {
  finishRun as persistRunOutcome,
  hasQueuedRun,
  insertQueuedRun,
  interruptRun,
  parseAppIds,
  readActiveRunRow,
  readNextQueuedRun,
  readRefreshRun,
  recoverInterruptedRuns as recoverRuns,
  markRunRunning,
  toRefreshRun,
  type RunOutcome,
} from "./run-persistence.ts";
import { emptyInternalStats } from "./stats.ts";
import { MetadataSourceRegistry, type MetadataSource } from "./sources.ts";
import type { InternalMetadataStats, RefreshRequest, RefreshRow, RunConfig } from "./types.ts";

/**
 * The general Refresh engine (spec §2.6, §4.3, §6.2-§6.4, §8.7).
 *
 * `start` validates, deduplicates, creates a `queued` run, and returns. A
 * single in-process worker then executes one run at a time. Library,
 * ownership, and metadata work live in their phase modules; this module owns
 * the run lifecycle and the order the phases run in.
 */

export interface RefreshConfigUpdate {
  steamRoot?: string | null;
  steamId64?: string | null;
  steamApiKey?: string | null;
}

export interface RefreshStartResult {
  run: RefreshRun;
  deduplicated: boolean;
}

export interface RefreshServiceOptions {
  db: BetterSqlite3.Database;
  steamRoot: string | null;
  steamId64: string | null;
  /** Server-side only. Never logged, stored, or returned. */
  steamApiKey?: string | null;
  now?: () => number;
  /** Monotonic milliseconds for request pacing. Tests pair it with `sleep`. */
  nowMs?: () => number;
  scan?: typeof scanLocalLibrary;
  /** Injectable ownership adapter. Tests use a fake; production builds one from the key. */
  ownershipSource?: SteamOwnershipSource;
  /** Metadata adapters. Empty until #28-#30 register real sources. */
  sources?: MetadataSourceRegistry | readonly MetadataSource[];
  /** Full-jitter source. Tests pass a deterministic value. */
  jitter?: () => number;
  /** Retry delay seam. Fake clocks advance time and resolve immediately. */
  sleep?: (milliseconds: number) => Promise<void>;
  onWarn?: (message: string, details: Record<string, unknown>) => void;
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function requestIdentity(scope: RefreshScope, mode: RefreshMode | null, appIds: number[] | null) {
  return JSON.stringify([scope, mode, appIds]);
}

function rowIdentity(row: RefreshRow): string {
  return requestIdentity(row.scope, row.mode, parseAppIds(row.app_ids_json));
}

function validateAppIds(value: unknown): { appIds: number[] | null; error: string | null } {
  if (!Array.isArray(value)) {
    return { appIds: null, error: "must be an array of App IDs" };
  }
  if (value.length === 0) {
    return { appIds: null, error: "must contain at least one App ID" };
  }
  if (value.length > MAX_REFRESH_APP_IDS) {
    return { appIds: null, error: `must contain at most ${MAX_REFRESH_APP_IDS} App IDs` };
  }
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      return { appIds: null, error: "must contain positive integers" };
    }
    if (seen.has(entry)) {
      return { appIds: null, error: "must not contain duplicates" };
    }
    seen.add(entry);
  }
  return { appIds: [...seen].sort((left, right) => left - right), error: null };
}

/**
 * Resolve the cross-field Refresh rules. The envelope types and the scope
 * enum are enforced by the route schema; what remains is which combinations
 * of scope, mode, and App IDs are legal.
 */
function parseRefreshRequest(body: unknown): RefreshRequest {
  const record = body as { scope: RefreshScope; mode?: unknown; appIds?: unknown };
  const fieldErrors: Record<string, string> = {};
  const validScope = record.scope;
  const rawMode = record.mode;
  const modeProvided = rawMode !== undefined;
  let mode: RefreshMode | null = null;

  if (validScope === "library" || validScope === "ownership") {
    if (modeProvided) {
      fieldErrors.mode = `${validScope} runs do not accept a mode`;
    }
  } else if (validScope === "all") {
    if (!modeProvided) {
      fieldErrors.mode = "is required";
    } else if (rawMode !== "fetch") {
      fieldErrors.mode = "all runs require mode fetch";
    } else {
      mode = "fetch";
    }
  } else {
    if (!modeProvided) {
      fieldErrors.mode = "is required";
    } else if (rawMode !== "fetch" && rawMode !== "full") {
      fieldErrors.mode = "must be fetch or full";
    } else {
      mode = rawMode;
    }
  }

  const rawAppIds = record.appIds;
  // An explicit `null` is not a valid selection for any scope; only an omitted
  // key is "not provided".
  const appIdsProvided = rawAppIds !== undefined;
  let appIds: number[] | null = null;
  if (validScope === "metadata" && mode === "full") {
    if (rawAppIds === undefined || rawAppIds === null) {
      fieldErrors.appIds = "is required for a full Refresh";
    } else {
      const parsed = validateAppIds(rawAppIds);
      if (parsed.error !== null) {
        fieldErrors.appIds = parsed.error;
      } else {
        appIds = parsed.appIds;
      }
    }
  } else if (appIdsProvided) {
    fieldErrors.appIds =
      validScope === "metadata"
        ? "is only valid with mode full"
        : `${validScope} runs do not accept appIds`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw validationError(fieldErrors, "body");
  }

  return {
    scope: validScope,
    mode: validScope === "library" || validScope === "ownership" ? null : mode,
    appIds,
  };
}

export class RefreshService {
  private readonly db: BetterSqlite3.Database;
  private readonly now: () => number;
  private readonly nowMs: () => number;
  private readonly jitter: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly sources: MetadataSourceRegistry;
  /** Aborted on shutdown so upstream requests and backoff waits stop promptly. */
  private readonly stopController = new AbortController();
  private worker: Promise<void> | null = null;
  private stopping = false;
  /** Live settings for the next run; an in-flight run uses its snapshot. */
  private currentConfig: RunConfig;
  private readonly runConfigs = new Map<number, RunConfig>();

  constructor(private readonly options: RefreshServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? unixSeconds;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.jitter = options.jitter ?? Math.random;
    this.sleep = options.sleep ?? ((milliseconds) => this.sleepUnlessStopped(milliseconds));
    this.sources =
      options.sources instanceof MetadataSourceRegistry
        ? options.sources
        : new MetadataSourceRegistry(options.sources ?? []);
    this.currentConfig = {
      steamRoot: options.steamRoot,
      steamId64: options.steamId64,
      steamApiKey: options.steamApiKey ?? null,
    };
  }

  /** Apply settings written through `PATCH /api/config` to the next run. */
  applyConfig(update: RefreshConfigUpdate): void {
    if (update.steamRoot !== undefined) {
      this.currentConfig.steamRoot = update.steamRoot;
    }
    if (update.steamId64 !== undefined) {
      this.currentConfig.steamId64 = update.steamId64;
    }
    if (update.steamApiKey !== undefined) {
      this.currentConfig.steamApiKey = update.steamApiKey;
    }
  }

  /** Validate and enqueue a documented run. Execution continues in the background. */
  async start(body: unknown): Promise<RefreshStartResult> {
    const request = parseRefreshRequest(body);
    if (request.scope === "ownership") {
      this.assertOwnershipConfigured();
    }

    const running = this.readActiveRow();
    if (running !== undefined) {
      if (rowIdentity(running) === requestIdentity(request.scope, request.mode, request.appIds)) {
        return { run: toRefreshRun(running), deduplicated: true };
      }
      throw new HttpError(
        409,
        "REFRESH_IN_PROGRESS",
        "Another Refresh run is already in progress.",
        {
          details: {
            runId: String(running.id),
            scope: running.scope,
            mode: running.mode,
          },
        },
      );
    }

    const startedAt = this.now();
    const steamId64 = this.steamIdForRun(request.scope);
    const id = insertQueuedRun(this.db, {
      scope: request.scope,
      mode: request.mode,
      appIds: request.appIds,
      steamId64,
      startedAt,
    });
    this.runConfigs.set(id, { ...this.currentConfig });
    this.enqueue();
    return { run: readRefreshRun(this.db, id)!, deduplicated: false };
  }

  get(id: number): RefreshRun | null {
    return readRefreshRun(this.db, id);
  }

  /** Resolve when the single worker has no queued or running work. */
  async waitForIdle(): Promise<void> {
    while (this.worker !== null) {
      await this.worker;
    }
  }

  /**
   * Startup recovery (§8.7): no run survives a restart as `queued` or
   * `running`. Completed per-Game and per-source rows are untouched.
   */
  recoverInterruptedRuns(): number {
    return recoverRuns(this.db, this.now());
  }

  /**
   * Graceful shutdown (§8.9): mark the active run immediately, then let the
   * worker observe the stop flag and unwind without finishing the run.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stopController.abort();
    const row = this.readActiveRow();
    if (row !== undefined) {
      interruptRun(this.db, row, this.now(), "The Refresh run was interrupted by shutdown.");
    }
    if (this.worker !== null) {
      await this.worker;
    }
  }

  /** Backoff that never delays a graceful shutdown for up to a minute. */
  private sleepUnlessStopped(milliseconds: number): Promise<void> {
    if (this.stopping || this.stopController.signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.stopController.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      this.stopController.signal.addEventListener("abort", finish, { once: true });
    });
  }

  private steamIdForRun(scope: RefreshScope): string | null {
    const bound = readBoundSteamId64(this.db);
    if (scope === "metadata") {
      return bound;
    }
    if (scope === "all") {
      return (
        bound ??
        (this.ownershipConfigured(this.currentConfig) ? this.currentConfig.steamId64 : null)
      );
    }
    return bound ?? this.currentConfig.steamId64;
  }

  private readActiveRow(): RefreshRow | undefined {
    return readActiveRunRow(this.db);
  }

  private enqueue(): void {
    if (this.worker !== null || this.stopping) {
      return;
    }
    this.worker = Promise.resolve()
      .then(() => this.drain())
      .catch((error: unknown) => {
        this.options.onWarn?.("The Refresh worker failed.", {
          error: (error as Error).message,
        });
      })
      .finally(() => {
        this.worker = null;
        if (!this.stopping && this.hasQueued()) {
          this.enqueue();
        }
      });
  }

  private hasQueued(): boolean {
    return hasQueuedRun(this.db);
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const row = readNextQueuedRun(this.db);
      if (row === undefined) {
        return;
      }
      markRunRunning(this.db, row.id);
      const running = { ...row, status: "running" as const };
      try {
        await this.execute(running);
      } catch (error) {
        if (!this.stopping) {
          this.finishRun(row.id, {
            status: "failed",
            total: row.total,
            done: row.done,
            stats:
              row.scope === "library" || row.scope === "ownership"
                ? null
                : (row.stats_json ?? JSON.stringify(emptyInternalStats())),
            error: {
              code: "INTERNAL_ERROR",
              message: `The Refresh run failed: ${(error as Error).message}`,
            },
          });
        }
      } finally {
        this.runConfigs.delete(row.id);
      }
    }
  }

  private async execute(row: RefreshRow): Promise<void> {
    const config = this.runConfigs.get(row.id) ?? this.currentConfig;
    switch (row.scope) {
      case "library":
        await this.executeLibrary(row, config);
        return;
      case "ownership":
        await this.executeOwnership(row, config);
        return;
      case "metadata":
        await this.executeMetadata(row);
        return;
      case "all":
        await this.executeAll(row, config);
        return;
    }
  }

  private assertOwnershipConfigured(): void {
    const missing: string[] = [];
    if (this.currentConfig.steamApiKey === null) {
      missing.push("webApiKey");
    }
    if (this.currentConfig.steamId64 === null) {
      missing.push("steamId64");
    }
    if (missing.length > 0) {
      throw new HttpError(
        409,
        "OWNERSHIP_NOT_CONFIGURED",
        "Ownership cannot be refreshed until the Web API key and Steam Account are configured.",
        { details: { missing } },
      );
    }
  }

  private ownershipConfigured(config: RunConfig): boolean {
    return config.steamApiKey !== null && config.steamId64 !== null;
  }

  private async executeLibrary(row: RefreshRow, config: RunConfig): Promise<void> {
    const phase = performLibraryPhase(this.libraryPhaseOptions(config));
    if (this.stopping) {
      return;
    }
    this.finishRun(row.id, {
      status: phase.status,
      total: phase.result.stats.upserted,
      done: phase.result.stats.upserted,
      stats: JSON.stringify({
        ...phase.result.stats,
        ...(phase.result.skipped === null ? {} : { skipped: phase.result.skipped }),
      }),
      error: phase.error,
    });
  }

  private async executeOwnership(row: RefreshRow, config: RunConfig): Promise<void> {
    const phase = await performOwnershipPhase(this.ownershipPhaseOptions(row.id, config));
    if (this.stopping) {
      return;
    }
    this.finishRun(row.id, {
      status: phase.status === "skipped" ? "partial" : phase.status,
      total: phase.total,
      done: phase.done,
      stats: null,
      error: phase.error,
    });
  }

  private async executeMetadata(row: RefreshRow): Promise<void> {
    const phase = await executeMetadataPhase(row.id, this.metadataPhaseOptions());
    if (this.stopping) {
      return;
    }
    this.finishRun(row.id, {
      status: phase.fatal ? "failed" : phase.partial ? "partial" : "succeeded",
      total: phase.total,
      done: phase.done,
      stats: JSON.stringify(phase.stats),
      error: phase.error,
    });
  }

  private async executeAll(row: RefreshRow, config: RunConfig): Promise<void> {
    const library = performLibraryPhase(this.libraryPhaseOptions(config));
    const libraryWarnings = { ...library.result.stats.warnings };
    const allStats = (stats: InternalMetadataStats): string =>
      JSON.stringify({ ...stats, warnings: libraryWarnings });
    if (library.fatal) {
      this.finishRun(row.id, {
        status: "failed",
        total: null,
        done: 0,
        stats: allStats(emptyInternalStats()),
        error: library.error,
      });
      return;
    }
    if (this.stopping) {
      return;
    }

    let partial = library.partial;
    let error = library.error;
    const ownership = await performOwnershipPhase(this.ownershipPhaseOptions(row.id, config));
    if (ownership.fatal || ownership.status === "failed") {
      this.finishRun(row.id, {
        status: "failed",
        total: null,
        done: 0,
        stats: allStats(emptyInternalStats()),
        error: ownership.error,
      });
      return;
    }
    if (this.stopping) {
      return;
    }

    const metadata = await executeMetadataPhase(row.id, this.metadataPhaseOptions());
    if (this.stopping) {
      return;
    }

    if (metadata.fatal) {
      this.finishRun(row.id, {
        status: "failed",
        total: metadata.total,
        done: metadata.done,
        stats: allStats(metadata.stats),
        error: metadata.error,
      });
      return;
    }

    // An `all` run without ownership is explicitly partial with this code.
    if (ownership.status === "skipped") {
      partial = true;
      error = ownership.error;
    } else if (ownership.partial) {
      partial = true;
      error ??= ownership.error;
    }
    if (metadata.partial) {
      partial = true;
      error ??= metadata.error;
    }
    if (library.partial) {
      partial = true;
      error ??= library.error;
    }

    this.finishRun(row.id, {
      status: partial ? "partial" : "succeeded",
      total: metadata.total,
      done: metadata.done,
      stats: allStats(metadata.stats),
      error,
    });
  }

  private finishRun(id: number, outcome: RunOutcome): void {
    if (this.stopping) {
      return;
    }
    persistRunOutcome(this.db, id, outcome, this.now());
  }

  private libraryPhaseOptions(config: RunConfig): LibraryPhaseOptions {
    return {
      db: this.db,
      steamRoot: config.steamRoot,
      steamId64: config.steamId64,
      now: this.now,
      scan: this.options.scan,
      onWarn: this.options.onWarn,
    };
  }

  private ownershipPhaseOptions(runId: number, config: RunConfig): OwnershipPhaseOptions {
    return {
      db: this.db,
      runId,
      config,
      now: this.now,
      signal: this.stopController.signal,
      ownershipSource: this.options.ownershipSource,
      onWarn: this.options.onWarn,
    };
  }

  private metadataPhaseOptions(): MetadataPhaseOptions {
    return {
      db: this.db,
      sources: this.sources,
      now: this.now,
      nowMs: this.nowMs,
      jitter: this.jitter,
      sleep: this.sleep,
      signal: this.stopController.signal,
      isStopping: () => this.stopping,
    };
  }
}

export {
  readActiveRefresh,
  readLastRefresh,
  readRefreshRun,
  toRefreshRun,
} from "./run-persistence.ts";
