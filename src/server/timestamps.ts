/**
 * The single Unix-seconds to API timestamp formatter (§4.1).
 *
 * API timestamps are ISO-8601 UTC with `Z` and no milliseconds. `null`,
 * `undefined`, and non-positive values mean unknown, never epoch zero.
 */
export function toIsoTimestamp(seconds: number): string;
export function toIsoTimestamp(seconds: number | null | undefined): string | null;
export function toIsoTimestamp(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
