import type { Status } from "../shared/types.ts";

export class ApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
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

  if (!response.ok) {
    throw new ApiError(`Status request failed with ${response.status}`, response.status);
  }

  const body = (await response.json()) as { data: Status };
  return body.data;
}
