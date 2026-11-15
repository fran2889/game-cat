import type { OwnershipStatus, ReviewTone } from "../shared/types.ts";

const COVER_BASE = "https://cdn.akamai.steamstatic.com/steam/apps";

export function coverUrl(appId: number): string {
  return `${COVER_BASE}/${appId}/header.jpg`;
}

export function initialsFor(name: string): string {
  const words = name
    .split(/[\s:–—-]+/)
    .map((word) => word.trim())
    .filter((word) => word !== "");
  if (words.length === 0) {
    return "?";
  }
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function hashHue(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360;
  }
  return hash;
}

export function formatPlaytime(minutes: number): string {
  if (minutes <= 0) {
    return "Not played";
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} m`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes < 0) {
    return "—";
  }
  if (bytes < 1_000) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1_000;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDate(iso: string | null): string {
  if (iso === null) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return DATE_FORMAT.format(date);
}

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export function formatTimestamp(iso: string | null): string {
  if (iso === null) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return `${DATE_TIME_FORMAT.format(date)} UTC`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function ownershipLabel(status: OwnershipStatus): string {
  switch (status) {
    case "local_only":
      return "Local only";
    case "unknown":
      return "Unknown ownership";
    default:
      return "Owned";
  }
}

export function reviewTone(score: number | null): ReviewTone {
  if (score === null) {
    return "none";
  }
  if (score >= 90) {
    return "great";
  }
  if (score >= 70) {
    return "good";
  }
  if (score >= 40) {
    return "mixed";
  }
  return "bad";
}

export function reviewPillLabel(score: number | null): string | null {
  return score === null ? null : `${score}%`;
}

/** Card line: tier and count, or the documented empty-state copy. */
export function reviewCardLabel(tier: string | null, count: number | null): string {
  if (count === 0) {
    return "No user reviews";
  }
  if (count === null) {
    return "Reviews unavailable";
  }
  return `${tier ?? "—"} · ${formatCount(count)} reviews`;
}

/** Detail and table line: score, tier, and count, or the empty-state copy. */
export function reviewSummaryLabel(
  score: number | null,
  tier: string | null,
  count: number | null,
): string {
  if (count === 0) {
    return "No user reviews";
  }
  if (score === null) {
    return "Reviews unavailable";
  }
  return `${score}% · ${tier ?? "—"} · ${formatCount(count ?? 0)} reviews`;
}

export function platformLabels(
  platforms: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  } | null,
): string[] {
  if (platforms === null) {
    return [];
  }
  const labels: string[] = [];
  if (platforms.windows === true) {
    labels.push("Windows");
  }
  if (platforms.mac === true) {
    labels.push("macOS");
  }
  if (platforms.linux === true) {
    labels.push("Linux");
  }
  return labels;
}

export function dash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return String(value);
}
