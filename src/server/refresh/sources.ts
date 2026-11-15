import type BetterSqlite3 from "better-sqlite3";

/**
 * Metadata source adapters (spec §6.1, §6.2).
 *
 * The engine owns selection, pacing, retry, progress, and `source_state`. An
 * adapter owns exactly one upstream request and its own persisted row; it never
 * touches `refresh_runs` or `source_state`. This keeps #28-#30 independent and
 * lets tests replace every adapter without a real network.
 */

export const METADATA_SOURCE_NAMES = ["steamspy", "storefront", "steam_reviews"] as const;

export type MetadataSourceName = (typeof METADATA_SOURCE_NAMES)[number];

export interface MetadataSourceGame {
  appId: number;
  name: string;
}

export interface MetadataSourceContext {
  db: BetterSqlite3.Database;
  game: MetadataSourceGame;
  /** Unix seconds. Adapters must use this instead of reading the clock. */
  now: number;
}

/**
 * `ok`, `missing`, and `unavailable` are successful answers. The adapter has
 * already persisted the per-Game row and its `*_fetched_at`; the engine counts
 * one completed item and keeps the data.
 *
 * `rate_limited` and `blocked` pause the whole source. `error` is an upstream
 * failure the engine retries and ultimately records as `failed`; set
 * `retryable: false` for a terminal request-shape failure such as a `400`.
 */
export type MetadataSourceOutcome =
  | { kind: "ok" }
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "rate_limited"; retryAfterAt: number | null; message: string }
  | { kind: "blocked"; message: string }
  | { kind: "error"; message: string; retryable?: boolean };

export interface MetadataSource {
  readonly name: MetadataSourceName;
  /**
   * Sources with the same host key never run concurrently and share a pause
   * (`storefront` and `steam_reviews` use the store host). Omit for a source
   * with its own host, such as SteamSpy.
   */
  readonly hostKey?: string;
  /** Fetch one Game. Upstream failures are returned, never thrown. */
  fetch(context: MetadataSourceContext): Promise<MetadataSourceOutcome>;
}

/** Canonical, deterministic registry. Later adapters register here. */
export class MetadataSourceRegistry {
  private readonly sources = new Map<MetadataSourceName, MetadataSource>();

  constructor(sources: readonly MetadataSource[] = []) {
    for (const source of sources) {
      this.register(source);
    }
  }

  register(source: MetadataSource): this {
    this.sources.set(source.name, source);
    return this;
  }

  get(name: MetadataSourceName): MetadataSource | undefined {
    return this.sources.get(name);
  }

  /** Registered sources in the documented `steamspy`, `storefront`, `steam_reviews` order. */
  entries(): MetadataSource[] {
    const result: MetadataSource[] = [];
    for (const name of METADATA_SOURCE_NAMES) {
      const source = this.sources.get(name);
      if (source !== undefined) {
        result.push(source);
      }
    }
    return result;
  }

  get size(): number {
    return this.sources.size;
  }
}
