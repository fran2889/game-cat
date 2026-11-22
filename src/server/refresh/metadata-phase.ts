import type BetterSqlite3 from "better-sqlite3";
import { sql, type CompiledQuery } from "kysely";
import {
  METADATA_SOURCE_NAMES,
  type MetadataSourceName,
  type SourceStatus,
} from "../../shared/types.ts";
import { allSync, firstSync, queryFor, runSync } from "../db/query.ts";
import { parseAppIds, readRunRow, writeProgress as persistProgress } from "./run-persistence.ts";
import {
  type MetadataSource,
  type MetadataSourceRegistry,
  type MetadataSourceOutcome,
} from "./sources.ts";
import { emptyInternalStats } from "./stats.ts";
import type {
  HostPause,
  MetadataPhaseResult,
  RefreshRow,
  SelectionPlan,
  WorkItem,
} from "./types.ts";

/**
 * The Metadata phase (spec §6.2-§6.4, §6.8, §8.7).
 *
 * Selection is per `(Game, source)`. Registered sources with the same host key
 * run one after another and share a pause; separate hosts run concurrently.
 * Pacing, retry/backoff, circuit breaking, and the 25-item progress cadence
 * live here so the worker only starts and finishes runs.
 */

const MAX_ATTEMPTS = 5;
const CIRCUIT_FAILURES = 5;
const BLOCK_SECONDS = 15 * 60;
const PROGRESS_INTERVAL = 25;
/**
 * Serial request pacing from §6.1: SteamSpy is about one request/second.
 * Storefront and reviews use separate hosts and each gets a 1.5-second
 * interval. The first request for a host is never delayed.
 */
const PACING_MS: Record<string, number> = {
  steamspy: 1_000,
  store: 1_500,
  steam_web_api: 1_500,
};

/** Per-Game rows used to select pending work and to reconcile `source_state`. */
const SOURCE_ROW_QUERIES: Record<MetadataSourceName, string> = {
  steamspy:
    "SELECT app_id, tags_status AS status, tags_fetched_at AS fetched_at, updated_at FROM steamspy_appdetails",
  storefront:
    "SELECT app_id, store_status AS status, store_fetched_at AS fetched_at, updated_at FROM storefront_appdetails",
  steam_reviews:
    "SELECT app_id, review_status AS status, review_fetched_at AS fetched_at, updated_at FROM steam_review_summaries",
};

export interface MetadataPhaseOptions {
  db: BetterSqlite3.Database;
  sources: MetadataSourceRegistry;
  now: () => number;
  /** Monotonic milliseconds for request pacing. Tests pair it with `sleep`. */
  nowMs: () => number;
  /** Full-jitter source. Tests pass a deterministic value. */
  jitter: () => number;
  /** Retry delay seam. Fake clocks advance time and resolve immediately. */
  sleep: (milliseconds: number) => Promise<void>;
  /** Aborted on shutdown so upstream requests and backoff waits stop promptly. */
  signal: AbortSignal;
  isStopping: () => boolean;
}

export async function executeMetadataPhase(
  runId: number,
  options: MetadataPhaseOptions,
): Promise<MetadataPhaseResult> {
  const row = readRunRow(options.db, runId) as RefreshRow;
  const plan = buildSelection(row, options);
  if (plan.missingAppIds.length > 0) {
    plan.partial = true;
  }

  // Per-Game rows can exist without a source row when an earlier pass was
  // interrupted. Reconcile a source with no pending work so a no-op Fetch
  // still reports its real last success and attempt. A Full Refresh always
  // selects its Games, so this repair belongs to Fetch only.
  if (row.mode === "fetch") {
    reconcileMetadataSourceState(plan, options);
  }

  // Source-wide backoff skips candidates without touching their data. The
  // work remains pending for a later Fetch.
  const retryAfter = readRetryAfter(options);
  for (const source of options.sources.entries()) {
    const deadline = retryAfter.get(source.name) ?? null;
    if (deadline !== null && deadline > options.now()) {
      const items = plan.items.get(source.name) ?? [];
      if (items.length > 0) {
        plan.stats.sources[source.name].skipped += items.length;
        plan.partial = true;
        for (const item of items) {
          resolveGame(plan, item.appId);
        }
        plan.items.set(source.name, []);
      }
    }
  }

  writeProgress(runId, plan, options);
  if (options.isStopping()) {
    return stoppedResult(plan);
  }

  const groups = new Map<string, MetadataSource[]>();
  for (const source of options.sources.entries()) {
    if ((plan.items.get(source.name)?.length ?? 0) === 0) {
      continue;
    }
    const key = source.hostKey ?? `source:${source.name}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [source]);
    } else {
      group.push(source);
    }
  }

  const hostPause = new Map<string, HostPause>();
  /** Last upstream request time in milliseconds, per host key, for pacing. */
  const lastRequestAt = new Map<string, number>();
  let lastPersistedDone = plan.done;
  const persistIfNeeded = (): void => {
    if (plan.done - lastPersistedDone >= PROGRESS_INTERVAL) {
      lastPersistedDone = plan.done;
      writeProgress(runId, plan, options);
    }
  };

  const executeGroup = async (sources: MetadataSource[]): Promise<void> => {
    for (const source of sources) {
      if (options.isStopping()) {
        return;
      }
      await executeSourcePass(source, plan, hostPause, lastRequestAt, persistIfNeeded, options);
    }
  };

  await Promise.all([...groups.values()].map((group) => executeGroup(group)));

  if (options.isStopping()) {
    return stoppedResult(plan);
  }

  // Finish with done exactly at total; the worker persists the final value.
  plan.done = plan.total;
  writeProgress(runId, plan, options);
  return {
    total: plan.total,
    done: plan.done,
    stats: plan.stats,
    partial: plan.partial,
    error: null,
    fatal: false,
  };
}

function stoppedResult(plan: SelectionPlan): MetadataPhaseResult {
  return {
    total: plan.total,
    done: plan.done,
    stats: plan.stats,
    partial: true,
    error: null,
    fatal: false,
  };
}

function sourceRowQuery(db: BetterSqlite3.Database, name: MetadataSourceName): CompiledQuery {
  const query = queryFor(db);
  switch (name) {
    case "steamspy":
      return query
        .selectFrom("steamspy_appdetails")
        .select([
          "app_id as app_id",
          "tags_status as status",
          "tags_fetched_at as fetched_at",
          "updated_at as updated_at",
        ])
        .compile();
    case "storefront":
      return query
        .selectFrom("storefront_appdetails")
        .select([
          "app_id as app_id",
          "store_status as status",
          "store_fetched_at as fetched_at",
          "updated_at as updated_at",
        ])
        .compile();
    case "steam_reviews":
      return query
        .selectFrom("steam_review_summaries")
        .select([
          "app_id as app_id",
          "review_status as status",
          "review_fetched_at as fetched_at",
          "updated_at as updated_at",
        ])
        .compile();
  }
}

function isMetadataPending(status: string | undefined, fetchedAt: number | null): boolean {
  if (status === undefined) {
    // No row for this source.
    return true;
  }
  if (status === "ok" || status === "unavailable") {
    return false;
  }
  if (status === "missing") {
    // A never-attempted miss is pending; a settled miss is not.
    return fetchedAt === null;
  }
  // `stale` and `error` are retried.
  return true;
}

function buildSelection(row: RefreshRow, options: MetadataPhaseOptions): SelectionPlan {
  const plan: SelectionPlan = {
    total: 0,
    items: new Map(),
    missingAppIds: [],
    remainingByGame: new Map(),
    done: 0,
    stats: emptyInternalStats(),
    partial: false,
  };

  const sources = options.sources.entries();
  const rows = allSync<{ app_id: number; name: string }>(
    options.db,
    queryFor(options.db)
      .selectFrom("games")
      .select(["app_id as app_id", "name as name"])
      .orderBy("app_id", "asc")
      .compile(),
  );
  const games = new Map(rows.map((game) => [game.app_id, game.name]));
  const retryAfter = readRetryAfter(options);

  if (row.scope === "metadata" && row.mode === "full") {
    const selection = parseAppIds(row.app_ids_json) ?? [];
    plan.total = selection.length;
    const selectedKeys = new Set(selection);
    const missing = new Set(selection);
    for (const game of rows) {
      if (selectedKeys.has(game.app_id)) {
        missing.delete(game.app_id);
      }
    }
    plan.missingAppIds = [...missing].sort((left, right) => left - right);

    for (const source of sources) {
      plan.items.set(source.name, []);
      plan.stats.sources[source.name].candidates = selection.length;
    }

    for (const appId of selection) {
      const name = games.get(appId);
      if (name === undefined) {
        // A missing App ID makes the run partial but still finishes.
        plan.partial = true;
        for (const source of sources) {
          plan.stats.sources[source.name].skipped += 1;
        }
        continue;
      }
      if (sources.length === 0) {
        plan.done += 1;
        continue;
      }
      plan.remainingByGame.set(appId, sources.length);
      for (const source of sources) {
        const deadline = retryAfter.get(source.name) ?? null;
        if (deadline !== null && deadline > options.now()) {
          plan.stats.sources[source.name].skipped += 1;
          plan.partial = true;
          resolveGame(plan, appId);
        } else {
          plan.items.get(source.name)!.push({ appId, name });
        }
      }
    }

    // Missing App IDs count against `done` but have no Game row.
    plan.done += plan.missingAppIds.length;
    plan.partial = plan.partial || plan.missingAppIds.length > 0;
    return plan;
  }

  // Fetch selection: pending is per `(Game, source)`.
  for (const source of sources) {
    const statusRows = allSync<{
      app_id: number;
      status: string;
      fetched_at: number | null;
    }>(options.db, sourceRowQuery(options.db, source.name));
    const byGame = new Map(statusRows.map((entry) => [entry.app_id, entry]));
    const items: WorkItem[] = [];
    for (const game of rows) {
      const stored = byGame.get(game.app_id);
      if (isMetadataPending(stored?.status, stored?.fetched_at ?? null)) {
        items.push({ appId: game.app_id, name: game.name });
      }
    }
    plan.items.set(source.name, items);
    plan.stats.sources[source.name].candidates = items.length;
  }

  const pendingAppIds = new Set<number>();
  for (const source of sources) {
    for (const item of plan.items.get(source.name) ?? []) {
      pendingAppIds.add(item.appId);
      plan.remainingByGame.set(item.appId, (plan.remainingByGame.get(item.appId) ?? 0) + 1);
    }
  }
  plan.total = pendingAppIds.size;
  return plan;
}

function readRetryAfter(options: MetadataPhaseOptions): Map<MetadataSourceName, number | null> {
  const rows = allSync<{ name: string; retry_after_at: number | null }>(
    options.db,
    queryFor(options.db)
      .selectFrom("source_state")
      .select(["name as name", "retry_after_at as retry_after_at"])
      .compile(),
  );
  const values = new Map<MetadataSourceName, number | null>();
  for (const row of rows) {
    if ((METADATA_SOURCE_NAMES as readonly string[]).includes(row.name)) {
      values.set(row.name as MetadataSourceName, row.retry_after_at);
    }
  }
  return values;
}

function resolveGame(plan: SelectionPlan, appId: number): void {
  const remaining = plan.remainingByGame.get(appId);
  if (remaining === undefined) {
    return;
  }
  const next = remaining - 1;
  if (next <= 0) {
    plan.remainingByGame.delete(appId);
    plan.done += 1;
  } else {
    plan.remainingByGame.set(appId, next);
  }
}

async function executeSourcePass(
  source: MetadataSource,
  plan: SelectionPlan,
  hostPause: Map<string, HostPause>,
  lastRequestAt: Map<string, number>,
  persistIfNeeded: () => void,
  options: MetadataPhaseOptions,
): Promise<void> {
  const items = plan.items.get(source.name) ?? [];
  if (items.length === 0) {
    return;
  }
  const hostKey = source.hostKey ?? `source:${source.name}`;
  const pacingKey = source.hostKey ?? source.name;
  const now = options.now();
  const pause = hostPause.get(hostKey) ?? null;
  if (pause !== null && pause.until > now) {
    plan.stats.sources[source.name].skipped += items.length;
    plan.partial = true;
    for (const item of items) {
      resolveGame(plan, item.appId);
    }
    plan.items.set(source.name, []);
    // A skipped pass inherits the pause reason from §6.8: a block stays
    // `blocked`, a 429 stays `rate_limited`.
    updateMetadataSourceState(
      source.name,
      {
        status: pause.reason,
        lastAttemptAt: null,
        lastSuccessAt: null,
        retryAfterAt: pause.until,
        lastError: "The shared store host is paused until its retry time.",
      },
      options,
    );
    persistIfNeeded();
    return;
  }

  let consecutiveFailures = 0;
  let successes = 0;
  let failures = 0;
  let nonRetryableFailures = 0;
  // A failure counted against the pass; it outranks the message from the most
  // recent failed attempt when the interruption write picks a last error.
  let lastCountedFailureMessage: string | null = null;
  let lastAttemptFailureMessage: string | null = null;
  let lastSuccessAt: number | null = null;
  let attemptedAt: number | null = null;
  let paused = false;

  try {
    for (let index = 0; index < items.length; index += 1) {
      if (options.isStopping()) {
        return;
      }
      const item = items[index]!;
      const pausePass = (pause: {
        at: number;
        until: number;
        reason: "rate_limited" | "blocked";
        message: string;
      }): void => {
        const previous = hostPause.get(hostKey);
        hostPause.set(hostKey, {
          until: Math.max(previous?.until ?? 0, pause.until),
          reason: pause.reason,
        });
        updateMetadataSourceState(
          source.name,
          {
            status: pause.reason,
            lastAttemptAt: pause.at,
            lastSuccessAt: null,
            retryAfterAt: pause.until,
            lastError: pause.message,
          },
          options,
        );
        skipFrom(plan, source.name, items, index);
        paused = true;
        persistIfNeeded();
      };
      let attempt = 0;

      while (true) {
        attempt += 1;
        if (options.isStopping()) {
          return;
        }
        await pace(pacingKey, lastRequestAt, options);
        if (options.isStopping()) {
          return;
        }
        lastRequestAt.set(pacingKey, options.nowMs());
        // §6.4: a source row is committed as work completes. Record the first
        // attempt before the request so an in-flight or interrupted pass is
        // visible in `/errors`, not only in the run record.
        const startedAt = options.now();
        if (attemptedAt === null) {
          markMetadataSourceAttempted(source.name, startedAt, options);
        }
        attemptedAt = startedAt;
        let outcome: MetadataSourceOutcome;
        try {
          outcome = await source.fetch({
            db: options.db,
            game: item,
            now: options.now(),
            signal: options.signal,
          });
        } catch (error) {
          outcome = {
            kind: "error",
            message: `The ${source.name} request failed: ${(error as Error).message}`,
          };
        }
        if (options.isStopping()) {
          return;
        }

        if (outcome.kind === "ok" || outcome.kind === "missing" || outcome.kind === "unavailable") {
          plan.stats.sources[source.name].done += 1;
          successes += 1;
          lastSuccessAt = options.now();
          lastAttemptFailureMessage = null;
          consecutiveFailures = 0;
          resolveGame(plan, item.appId);
          persistIfNeeded();
          break;
        }

        // A non-success outcome is the most recent failed attempt. The
        // pass-end or interruption write reports it when no source-wide
        // terminal message exists.
        lastAttemptFailureMessage = outcome.message;

        if (outcome.kind === "rate_limited") {
          // No Retry-After means Steam gives no deadline: retry this request
          // with full-jitter exponential backoff (§6.8). Pacing still runs
          // before each attempt, and the source issues no other request while
          // the backoff waits. Once the attempts are exhausted, record the
          // source-wide pause for later Fetch runs.
          if (outcome.retryAfterAt === null && attempt < MAX_ATTEMPTS) {
            await options.sleep(backoffMilliseconds(attempt, options));
            continue;
          }
          const at = options.now();
          const until = outcome.retryAfterAt ?? at + backoffSeconds(attempt, options);
          pausePass({ at, until, reason: "rate_limited", message: outcome.message });
          return;
        }

        if (outcome.kind === "blocked") {
          const at = options.now();
          const until = at + BLOCK_SECONDS;
          pausePass({ at, until, reason: "blocked", message: outcome.message });
          return;
        }

        // A non-retryable `error` (for example a storefront `400`) records the
        // failure immediately and moves on without another request.
        if (outcome.retryable === false) {
          plan.stats.sources[source.name].failed += 1;
          failures += 1;
          nonRetryableFailures += 1;
          lastCountedFailureMessage = outcome.message;
          // A failed Game always makes the run partial, even when it is the
          // only Game and no retry follows (§6.4).
          plan.partial = true;
          resolveGame(plan, item.appId);
          persistIfNeeded();
          break;
        }

        // `error`: retry with full jitter, then record the failure and keep
        // going. Five consecutive failed attempts open the source circuit.
        consecutiveFailures += 1;
        if (consecutiveFailures >= CIRCUIT_FAILURES) {
          const at = options.now();
          const until = at + BLOCK_SECONDS;
          updateMetadataSourceState(
            source.name,
            {
              status: "error",
              lastAttemptAt: at,
              lastSuccessAt: null,
              retryAfterAt: until,
              lastError: outcome.message,
            },
            options,
          );
          plan.stats.sources[source.name].failed += 1;
          failures += 1;
          lastCountedFailureMessage = outcome.message;
          plan.partial = true;
          resolveGame(plan, item.appId);
          paused = true;
          skipFrom(plan, source.name, items, index + 1);
          persistIfNeeded();
          return;
        }

        if (attempt >= MAX_ATTEMPTS) {
          plan.stats.sources[source.name].failed += 1;
          failures += 1;
          lastCountedFailureMessage = outcome.message;
          // A failed Game always makes the run partial, even when no successful
          // Game hides the failure (§6.4 regression).
          plan.partial = true;
          resolveGame(plan, item.appId);
          persistIfNeeded();
          break;
        }

        await options.sleep(backoffMilliseconds(attempt, options));
      }
    }

    if (!paused) {
      const finishedAt = options.now();
      // A non-retryable (source-wide) failure is recorded as `error`; if other
      // Games already succeeded the source is `partial`. Retry-exhausted
      // per-Game failures leave the source row `ok` when some Games succeeded,
      // because a per-Game failure does not by itself change source state.
      const status: "ok" | "partial" | "error" =
        nonRetryableFailures > 0
          ? successes > 0
            ? "partial"
            : "error"
          : failures > 0 && successes === 0
            ? "error"
            : "ok";
      updateMetadataSourceState(
        source.name,
        {
          status,
          lastAttemptAt: finishedAt,
          lastSuccessAt: successes > 0 ? finishedAt : null,
          retryAfterAt: null,
          lastError:
            failures > 0 ? (lastCountedFailureMessage ?? "Some Games could not be fetched.") : null,
        },
        options,
      );
    }
    persistIfNeeded();
  } finally {
    // An interrupted pass still carries evidence: the latest attempt time, any
    // success before the stop, and the last safe failure. Without this the
    // source row would keep its last completed pass instead.
    if (!paused && options.isStopping() && attemptedAt !== null) {
      updateMetadataSourceState(
        source.name,
        {
          // A shutdown is not a failed attempt, so an interrupted pass is always
          // partial: it started (and maybe read data) but did not finish.
          status: "partial",
          // A success completes after the request started, so never let the
          // attempt timestamp land before the success timestamp.
          lastAttemptAt: Math.max(attemptedAt, lastSuccessAt ?? 0),
          lastSuccessAt,
          retryAfterAt: null,
          lastError:
            lastCountedFailureMessage ??
            lastAttemptFailureMessage ??
            (successes > 0 ? null : "The Refresh run stopped before this source finished."),
        },
        options,
      );
    }
  }
}

function skipFrom(
  plan: SelectionPlan,
  name: MetadataSourceName,
  items: WorkItem[],
  from: number,
): void {
  for (let index = from; index < items.length; index += 1) {
    const item = items[index]!;
    plan.stats.sources[name].skipped += 1;
    plan.partial = true;
    resolveGame(plan, item.appId);
  }
}

/**
 * Record that a Metadata source has started its first request. Replacing
 * `unknown` with `partial` keeps an in-flight pass from looking never
 * attempted; the pass-end or interruption write carries the final result
 * (§6.4).
 */
function markMetadataSourceAttempted(
  name: MetadataSourceName,
  at: number,
  options: MetadataPhaseOptions,
): void {
  runSync(
    options.db,
    queryFor(options.db)
      .updateTable("source_state")
      .set({
        last_attempt_at: at,
        status: sql<string>`CASE WHEN status = 'unknown' THEN 'partial' ELSE status END`,
      })
      .where("name", "=", name)
      .compile(),
  );
}

/**
 * Reconcile a Metadata source row from its per-Game rows when the source has
 * no pending work. Per-Game rows are committed before the source row, so an
 * interrupted pass can leave real data with no final source-level record, and
 * a later Fetch with nothing to do would never write it. A hard kill leaves
 * the row `partial`, so any non-`ok` row is repaired, not only `unknown`.
 *
 * A `missing` row with no `*_fetched_at` is pending, not attempted (§6.2), and
 * a source with any pending or failed per-Game row is skipped here because
 * its next pass writes the row. A reconciled row therefore always has a
 * successful `*_fetched_at` and becomes `ok`.
 */
function reconcileMetadataSourceState(plan: SelectionPlan, options: MetadataPhaseOptions): void {
  for (const source of options.sources.entries()) {
    if ((plan.items.get(source.name)?.length ?? 0) > 0) {
      continue;
    }
    const row = firstSync<{ status: SourceStatus }>(
      options.db,
      queryFor(options.db)
        .selectFrom("source_state")
        .select("status as status")
        .where("name", "=", source.name)
        .compile(),
    );
    if (row === undefined || row.status === "ok") {
      continue;
    }
    const aggregate = firstSync<{
      last_success_at: number | null;
      last_attempt_at: number | null;
      attempted: number;
    }>(
      options.db,
      queryFor(options.db)
        .selectFrom(sql`(${sql.raw(SOURCE_ROW_QUERIES[source.name])})`.as("t"))
        .select(sql<number | null>`MAX(fetched_at)`.as("last_success_at"))
        .select(sql<number | null>`MAX(updated_at)`.as("last_attempt_at"))
        .select(
          sql<number>`COUNT(CASE WHEN fetched_at IS NOT NULL OR status <> 'missing' THEN 1 END)`.as(
            "attempted",
          ),
        )
        .compile(),
    );
    if (aggregate === undefined || aggregate.attempted === 0) {
      continue;
    }
    runSync(
      options.db,
      queryFor(options.db)
        .updateTable("source_state")
        .set({
          status: "ok",
          last_success_at: aggregate.last_success_at,
          last_attempt_at: aggregate.last_attempt_at,
          retry_after_at: null,
          last_error: null,
        })
        .where("name", "=", source.name)
        .compile(),
    );
  }
}

function updateMetadataSourceState(
  name: MetadataSourceName,
  value: {
    status: "ok" | "partial" | "rate_limited" | "blocked" | "error";
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    retryAfterAt: number | null;
    lastError: string | null;
  },
  options: MetadataPhaseOptions,
): void {
  const existing = firstSync<{
    last_attempt_at: number | null;
    last_success_at: number | null;
  }>(
    options.db,
    queryFor(options.db)
      .selectFrom("source_state")
      .select(["last_attempt_at as last_attempt_at", "last_success_at as last_success_at"])
      .where("name", "=", name)
      .compile(),
  );
  runSync(
    options.db,
    queryFor(options.db)
      .updateTable("source_state")
      .set({
        status: value.status,
        last_attempt_at: value.lastAttemptAt ?? existing?.last_attempt_at ?? null,
        last_success_at: value.lastSuccessAt ?? existing?.last_success_at ?? null,
        retry_after_at: value.retryAfterAt,
        last_error: value.lastError,
      })
      .where("name", "=", name)
      .compile(),
  );
}

function writeProgress(runId: number, plan: SelectionPlan, options: MetadataPhaseOptions): void {
  if (options.isStopping()) {
    return;
  }
  plan.stats.lastProgressAt = options.now();
  persistProgress(options.db, runId, plan);
}

/**
 * Serial per-host pacing (§6.1). The map holds the last request time in
 * milliseconds; the first request for a host is not delayed. Tests inject a
 * fake clock through `sleep` and `nowMs`, so no suite actually waits.
 */
async function pace(
  pacingKey: string,
  lastRequestAt: Map<string, number>,
  options: MetadataPhaseOptions,
): Promise<void> {
  const intervalMs = PACING_MS[pacingKey] ?? 0;
  if (intervalMs <= 0) {
    return;
  }
  const last = lastRequestAt.get(pacingKey);
  if (last === undefined) {
    return;
  }
  const waitMs = Math.ceil(last + intervalMs - options.nowMs());
  if (waitMs > 0) {
    await options.sleep(waitMs);
  }
}

function backoffSeconds(attempt: number, options: MetadataPhaseOptions): number {
  const cap = Math.min(60, 2 * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(cap * options.jitter()));
}

function backoffMilliseconds(attempt: number, options: MetadataPhaseOptions): number {
  const cap = Math.min(60, 2 * 2 ** Math.max(0, attempt - 1));
  return Math.round(cap * 1_000 * options.jitter());
}
