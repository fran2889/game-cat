/**
 * Parse an upstream `Retry-After` header as delta-seconds or an HTTP date.
 * Anything else is unknown. Shared by every Keyless Metadata adapter and the
 * Steam Web API ownership refresh (§6.8).
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return now + Number.parseInt(trimmed, 10);
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}
