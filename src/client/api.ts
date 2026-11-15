import type { GamesResponse, RefreshRun, Status } from "../shared/types.ts";

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
  sort?: "name" | "playtime" | "lastPlayed" | "releaseYear" | "metacritic" | "appId";
  order?: "asc" | "desc";
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

export async function startLibraryScan(): Promise<RefreshRun> {
  const response = await fetch("/api/refresh", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ scope: "library" }),
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
