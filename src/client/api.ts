import { queryOptions } from "@tanstack/react-query";
import type {
  Config,
  ConfigPatchResponse,
  GameDetailResponse,
  GameOrder,
  GameSort,
  GamesResponse,
  RefreshMode,
  RefreshRun,
  RefreshScope,
  RuleValueField,
  RuleValuesResponse,
  Status,
  SteamAccountsResponse,
  SteamAccount,
  SteamCollectionGamesResponse,
  SteamCollectionSummary,
  SteamCollectionsResponse,
  TagsResponse,
} from "../shared/types.ts";
import type { Rule } from "../shared/rules.ts";
import type {
  SmartCollection,
  SmartCollectionGamesResponse,
  SmartCollectionPatchBody,
  SmartCollectionsResponse,
} from "../shared/smart-collections.ts";

export class ApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(
    message: string,
    status: number | null,
    options: { code?: string | null; details?: Record<string, unknown> | null } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = options.code ?? null;
    this.details = options.details ?? null;
  }

  get fieldErrors(): Record<string, string> {
    const value = this.details?.fieldErrors;
    return typeof value === "object" && value !== null ? (value as Record<string, string>) : {};
  }
}

function isAbortError(error: unknown): boolean {
  return (error as Error).name === "AbortError";
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    let code: string | null = null;
    let details: Record<string, unknown> | null = null;
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string; details?: Record<string, unknown> };
      };
      if (body.error?.message !== undefined) {
        message = body.error.message;
      }
      code = body.error?.code ?? null;
      details = body.error?.details ?? null;
    } catch {
      // Keep the status-based message when the body is not JSON.
    }
    throw new ApiError(message, response.status, { code, details });
  }
  return (await response.json()) as T;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/** One place that owns fetch, headers, transport errors, and abort handling. */
async function send(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  try {
    return await fetch(path, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ApiError((error as Error).message, null);
  }
}

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(await send(path, options));
}

async function requestNone(path: string, options: RequestOptions = {}): Promise<void> {
  const response = await send(path, options);
  if (!response.ok) {
    await readJson<never>(response);
  }
}

function queryString(params: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    query.set(key, String(value));
  }
  return query.toString();
}

export async function fetchStatus(signal?: AbortSignal): Promise<Status> {
  const body = await requestJson<{ data: Status }>("/api/status", { signal });
  return body.data;
}

export async function fetchConfig(signal?: AbortSignal): Promise<Config> {
  const body = await requestJson<{ data: Config }>("/api/config", { signal });
  return body.data;
}

export interface ConfigPatch {
  steamApiKey?: string;
  steamRoot?: string;
  steamId64?: string;
  port?: number;
  openBrowser?: boolean;
  logLevel?: string;
}

export async function patchConfig(patch: ConfigPatch): Promise<ConfigPatchResponse> {
  return requestJson<ConfigPatchResponse>("/api/config", {
    method: "PATCH",
    body: patch,
  });
}

export async function fetchSteamAccounts(signal?: AbortSignal): Promise<SteamAccount[]> {
  const body = await requestJson<SteamAccountsResponse>("/api/steam/accounts", { signal });
  return body.data;
}

export async function startAllFetch(): Promise<RefreshRun> {
  const body = await requestJson<{ data: RefreshRun }>("/api/refresh", {
    method: "POST",
    body: { scope: "all", mode: "fetch" },
  });
  return body.data;
}

export interface FetchGamesParams {
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: GameSort;
  order?: GameOrder;
  installed?: boolean;
  tagsStatus?: string;
  storeStatus?: string;
  reviewStatus?: string;
  tagsFetched?: boolean;
  storeFetched?: boolean;
  reviewFetched?: boolean;
}

export interface RefreshRequestBody {
  scope: RefreshScope;
  mode?: RefreshMode;
  appIds?: number[];
}

/** Start any documented Refresh request. The run executes in the background. */
export async function startRefresh(body: RefreshRequestBody): Promise<RefreshRun> {
  const result = await requestJson<{ data: RefreshRun }>("/api/refresh", {
    method: "POST",
    body,
  });
  return result.data;
}

export async function fetchGames(
  params: FetchGamesParams = {},
  signal?: AbortSignal,
): Promise<GamesResponse> {
  return requestJson<GamesResponse>(`/api/games?${queryString(params)}`, { signal });
}

export interface PreviewRulesBody {
  rules: Rule[];
  page?: number;
  pageSize?: number;
  sort?: GameSort;
  order?: GameOrder;
}

/** Evaluate an unsaved Rules array; the server never persists it (§4.3). */
export async function previewRules(
  body: PreviewRulesBody,
  signal?: AbortSignal,
): Promise<GamesResponse> {
  return requestJson<GamesResponse>("/api/rules/preview", {
    method: "POST",
    body,
    signal,
  });
}

export interface FetchTagsParams {
  query?: string;
  page?: number;
  pageSize?: number;
}

export async function fetchTags(
  params: FetchTagsParams = {},
  signal?: AbortSignal,
): Promise<TagsResponse> {
  return requestJson<TagsResponse>(`/api/tags?${queryString(params)}`, { signal });
}

export interface FetchRuleValuesParams {
  field: RuleValueField;
  query?: string;
  page?: number;
  pageSize?: number;
}

export async function fetchRuleValues(
  params: FetchRuleValuesParams,
  signal?: AbortSignal,
): Promise<RuleValuesResponse> {
  return requestJson<RuleValuesResponse>(`/api/rule-values?${queryString(params)}`, { signal });
}

export async function fetchGameDetail(
  appId: number,
  signal?: AbortSignal,
): Promise<GameDetailResponse["data"]> {
  const body = await requestJson<GameDetailResponse>(`/api/games/${appId}`, { signal });
  return body.data;
}

export async function startMetadataRefresh(appIds: number[]): Promise<RefreshRun> {
  const body = await requestJson<{ data: RefreshRun }>("/api/refresh", {
    method: "POST",
    body: { scope: "metadata", mode: "full", appIds },
  });
  return body.data;
}

export async function startLibraryScan(): Promise<RefreshRun> {
  const body = await requestJson<{ data: RefreshRun }>("/api/refresh", {
    method: "POST",
    body: { scope: "library" },
  });
  return body.data;
}

export interface FetchSteamCollectionsParams {
  page?: number;
  pageSize?: number;
}

export async function fetchSteamCollections(
  params: FetchSteamCollectionsParams = {},
  signal?: AbortSignal,
): Promise<SteamCollectionsResponse> {
  return requestJson<SteamCollectionsResponse>(`/api/steam-collections?${queryString(params)}`, {
    signal,
  });
}

export async function fetchSteamCollection(
  id: string,
  signal?: AbortSignal,
): Promise<SteamCollectionSummary> {
  const body = await requestJson<{ data: SteamCollectionSummary }>(
    `/api/steam-collections/${encodeURIComponent(id)}`,
    { signal },
  );
  return body.data;
}

export interface FetchSteamCollectionGamesParams extends FetchSteamCollectionsParams {
  sort?: GameSort;
  order?: GameOrder;
}

export async function fetchSteamCollectionGames(
  id: string,
  params: FetchSteamCollectionGamesParams = {},
  signal?: AbortSignal,
): Promise<SteamCollectionGamesResponse> {
  return requestJson<SteamCollectionGamesResponse>(
    `/api/steam-collections/${encodeURIComponent(id)}/games?${queryString(params)}`,
    { signal },
  );
}

export interface FetchSmartCollectionsParams {
  page?: number;
  pageSize?: number;
  sort?: "name" | "updatedAt";
  order?: GameOrder;
}

export async function fetchSmartCollections(
  params: FetchSmartCollectionsParams = {},
  signal?: AbortSignal,
): Promise<SmartCollectionsResponse> {
  return requestJson<SmartCollectionsResponse>(`/api/smart-collections?${queryString(params)}`, {
    signal,
  });
}

export async function fetchSmartCollection(
  id: string,
  signal?: AbortSignal,
): Promise<SmartCollection> {
  const body = await requestJson<{ data: SmartCollection }>(
    `/api/smart-collections/${encodeURIComponent(id)}`,
    { signal },
  );
  return body.data;
}

export async function createSmartCollection(body: {
  name: string;
  rules: Rule[];
}): Promise<SmartCollection> {
  const result = await requestJson<{ data: SmartCollection }>("/api/smart-collections", {
    method: "POST",
    body,
  });
  return result.data;
}

export async function patchSmartCollection(
  id: string,
  body: SmartCollectionPatchBody,
): Promise<SmartCollection> {
  const result = await requestJson<{ data: SmartCollection }>(
    `/api/smart-collections/${encodeURIComponent(id)}`,
    { method: "PATCH", body },
  );
  return result.data;
}

/** Delete a saved Smart Collection; callers treat 404 as already deleted (§7.4). */
export async function deleteSmartCollection(id: string): Promise<void> {
  await requestNone(`/api/smart-collections/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface FetchSmartCollectionGamesParams {
  page?: number;
  pageSize?: number;
  sort?: GameSort;
  order?: GameOrder;
}

export async function fetchSmartCollectionGames(
  id: string,
  params: FetchSmartCollectionGamesParams = {},
  signal?: AbortSignal,
): Promise<SmartCollectionGamesResponse> {
  return requestJson<SmartCollectionGamesResponse>(
    `/api/smart-collections/${encodeURIComponent(id)}/games?${queryString(params)}`,
    { signal },
  );
}

export async function fetchRefresh(id: string, signal?: AbortSignal): Promise<RefreshRun> {
  const body = await requestJson<{ data: RefreshRun }>(`/api/refresh/${encodeURIComponent(id)}`, {
    signal,
  });
  return body.data;
}

export const STATUS_POLL_INTERVAL_MS = 800;

/** Status polling is gated on an active run: queued or running, at 800 ms. */
export function statusRefetchInterval(status: Status | null | undefined): number | false {
  return status?.activeRefresh == null ? false : STATUS_POLL_INTERVAL_MS;
}

export const statusQueryKey = ["status"] as const;
export const statusQueryOptions = queryOptions({
  queryKey: statusQueryKey,
  queryFn: ({ signal }) => fetchStatus(signal),
  refetchInterval: (query) => statusRefetchInterval(query.state.data),
});

export const configQueryKey = ["config"] as const;
export const configQueryOptions = queryOptions({
  queryKey: configQueryKey,
  queryFn: ({ signal }) => fetchConfig(signal),
});

export const steamAccountsQueryOptions = queryOptions({
  queryKey: ["steam-accounts"] as const,
  queryFn: ({ signal }) => fetchSteamAccounts(signal),
});

export function gamesQueryOptions(params: FetchGamesParams = {}) {
  return queryOptions({
    queryKey: ["games", params] as const,
    queryFn: ({ signal }) => fetchGames(params, signal),
  });
}

export function tagsQueryOptions(params: FetchTagsParams = {}) {
  return queryOptions({
    queryKey: ["tags", params] as const,
    queryFn: ({ signal }) => fetchTags(params, signal),
  });
}

export function ruleValuesQueryOptions(params: FetchRuleValuesParams) {
  return queryOptions({
    queryKey: ["rule-values", params] as const,
    queryFn: ({ signal }) => fetchRuleValues(params, signal),
  });
}

export function gameDetailQueryOptions(appId: number) {
  return queryOptions({
    queryKey: ["game-detail", appId] as const,
    queryFn: ({ signal }) => fetchGameDetail(appId, signal),
  });
}

export function steamCollectionsQueryOptions(params: FetchSteamCollectionsParams = {}) {
  return queryOptions({
    queryKey: ["steam-collections", params] as const,
    queryFn: ({ signal }) => fetchSteamCollections(params, signal),
  });
}

export function steamCollectionQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["steam-collection", id] as const,
    queryFn: ({ signal }) => fetchSteamCollection(id, signal),
  });
}

export function steamCollectionGamesQueryOptions(
  id: string,
  params: FetchSteamCollectionGamesParams = {},
) {
  return queryOptions({
    queryKey: ["steam-collection-games", id, params] as const,
    queryFn: ({ signal }) => fetchSteamCollectionGames(id, params, signal),
  });
}

export function smartCollectionsQueryOptions(params: FetchSmartCollectionsParams = {}) {
  return queryOptions({
    queryKey: ["smart-collections", params] as const,
    queryFn: ({ signal }) => fetchSmartCollections(params, signal),
  });
}

export function smartCollectionQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["smart-collection", id] as const,
    queryFn: ({ signal }) => fetchSmartCollection(id, signal),
  });
}

export function smartCollectionGamesQueryOptions(
  id: string,
  params: FetchSmartCollectionGamesParams = {},
) {
  return queryOptions({
    queryKey: ["smart-collection-games", id, params] as const,
    queryFn: ({ signal }) => fetchSmartCollectionGames(id, params, signal),
  });
}

export function refreshQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["refresh", id] as const,
    queryFn: ({ signal }) => fetchRefresh(id, signal),
  });
}
