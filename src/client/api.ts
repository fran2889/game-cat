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

export async function fetchStatus(signal?: AbortSignal): Promise<Status> {
  let response: Response;
  try {
    response = await fetch("/api/status", {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    throw new ApiError((error as Error).message, null);
  }
  const body = await readJson<{ data: Status }>(response);
  return body.data;
}

export async function fetchConfig(signal?: AbortSignal): Promise<Config> {
  let response: Response;
  try {
    response = await fetch("/api/config", {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw error;
    }
    throw new ApiError((error as Error).message, null);
  }
  const body = await readJson<{ data: Config }>(response);
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
  const response = await fetch("/api/config", {
    method: "PATCH",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return readJson<ConfigPatchResponse>(response);
}

export async function fetchSteamAccounts(signal?: AbortSignal): Promise<SteamAccount[]> {
  const response = await fetch("/api/steam/accounts", {
    headers: { accept: "application/json" },
    signal,
  });
  const body = await readJson<SteamAccountsResponse>(response);
  return body.data;
}

export async function startAllFetch(): Promise<RefreshRun> {
  const response = await fetch("/api/refresh", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ scope: "all", mode: "fetch" }),
  });
  const body = await readJson<{ data: RefreshRun }>(response);
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
}

export interface RefreshRequestBody {
  scope: RefreshScope;
  mode?: RefreshMode;
  appIds?: number[];
}

/** Start any documented Refresh request. The run executes in the background. */
export async function startRefresh(body: RefreshRequestBody): Promise<RefreshRun> {
  const response = await fetch("/api/refresh", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await readJson<{ data: RefreshRun }>(response);
  return result.data;
}

export async function fetchGames(
  params: FetchGamesParams = {},
  signal?: AbortSignal,
): Promise<GamesResponse> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    query.set(key, String(value));
  }
  let response: Response;
  try {
    response = await fetch(`/api/games?${query.toString()}`, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw error;
    }
    throw new ApiError((error as Error).message, null);
  }
  return readJson<GamesResponse>(response);
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
  let response: Response;
  try {
    response = await fetch("/api/rules/preview", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw error;
    }
    throw new ApiError((error as Error).message, null);
  }
  return readJson<GamesResponse>(response);
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
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const response = await fetch(`/api/tags?${query.toString()}`, {
    headers: { accept: "application/json" },
    signal,
  });
  return readJson<TagsResponse>(response);
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
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const response = await fetch(`/api/rule-values?${query.toString()}`, {
    headers: { accept: "application/json" },
    signal,
  });
  return readJson<RuleValuesResponse>(response);
}

export async function fetchGameDetail(
  appId: number,
  signal?: AbortSignal,
): Promise<GameDetailResponse["data"]> {
  let response: Response;
  try {
    response = await fetch(`/api/games/${appId}`, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw error;
    }
    throw new ApiError((error as Error).message, null);
  }
  const body = await readJson<GameDetailResponse>(response);
  return body.data;
}

export async function startMetadataRefresh(appIds: number[]): Promise<RefreshRun> {
  const response = await fetch("/api/refresh", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ scope: "metadata", mode: "full", appIds }),
  });
  const body = await readJson<{ data: RefreshRun }>(response);
  return body.data;
}

export async function startLibraryScan(): Promise<RefreshRun> {
  const response = await fetch("/api/refresh", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ scope: "library" }),
  });
  const body = await readJson<{ data: RefreshRun }>(response);
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
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const response = await fetch(`/api/steam-collections?${query.toString()}`, {
    headers: { accept: "application/json" },
    signal,
  });
  return readJson<SteamCollectionsResponse>(response);
}

export async function fetchSteamCollection(
  id: string,
  signal?: AbortSignal,
): Promise<SteamCollectionSummary> {
  const response = await fetch(`/api/steam-collections/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
    signal,
  });
  const body = await readJson<{ data: SteamCollectionSummary }>(response);
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
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const response = await fetch(
    `/api/steam-collections/${encodeURIComponent(id)}/games?${query.toString()}`,
    { headers: { accept: "application/json" }, signal },
  );
  return readJson<SteamCollectionGamesResponse>(response);
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
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const response = await fetch(`/api/smart-collections?${query.toString()}`, {
    headers: { accept: "application/json" },
    signal,
  });
  return readJson<SmartCollectionsResponse>(response);
}

export async function fetchSmartCollection(
  id: string,
  signal?: AbortSignal,
): Promise<SmartCollection> {
  const response = await fetch(`/api/smart-collections/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
    signal,
  });
  const body = await readJson<{ data: SmartCollection }>(response);
  return body.data;
}

export async function createSmartCollection(body: {
  name: string;
  rules: Rule[];
}): Promise<SmartCollection> {
  const response = await fetch("/api/smart-collections", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await readJson<{ data: SmartCollection }>(response);
  return result.data;
}

export async function patchSmartCollection(
  id: string,
  body: SmartCollectionPatchBody,
): Promise<SmartCollection> {
  const response = await fetch(`/api/smart-collections/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await readJson<{ data: SmartCollection }>(response);
  return result.data;
}

/** Delete a saved Smart Collection; callers treat 404 as already deleted (§7.4). */
export async function deleteSmartCollection(id: string): Promise<void> {
  const response = await fetch(`/api/smart-collections/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    await readJson<never>(response);
  }
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
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const response = await fetch(
    `/api/smart-collections/${encodeURIComponent(id)}/games?${query.toString()}`,
    { headers: { accept: "application/json" }, signal },
  );
  return readJson<SmartCollectionGamesResponse>(response);
}

export async function fetchRefresh(id: string): Promise<RefreshRun> {
  const response = await fetch(`/api/refresh/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
  });
  const body = await readJson<{ data: RefreshRun }>(response);
  return body.data;
}
