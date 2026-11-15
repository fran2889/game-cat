import type {
  GameDetailResponse,
  GameOrder,
  GameSort,
  GamesResponse,
  RefreshRun,
  RuleValueField,
  RuleValuesResponse,
  Status,
  SteamCollectionGamesResponse,
  SteamCollectionSummary,
  SteamCollectionsResponse,
  TagsResponse,
} from "../shared/types.ts";
import type { Rule } from "../shared/rules.ts";

export class ApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message !== undefined) {
        message = body.error.message;
      }
    } catch {
      // Keep the status-based message when the body is not JSON.
    }
    throw new ApiError(message, response.status);
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

export interface FetchGamesParams {
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: GameSort;
  order?: GameOrder;
  installed?: boolean;
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

export async function startOwnershipRefresh(): Promise<RefreshRun> {
  const response = await fetch("/api/refresh", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ scope: "ownership" }),
  });
  const body = await readJson<{ data: RefreshRun }>(response);
  return body.data;
}

export async function fetchRefresh(id: string): Promise<RefreshRun> {
  const response = await fetch(`/api/refresh/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
  });
  const body = await readJson<{ data: RefreshRun }>(response);
  return body.data;
}
