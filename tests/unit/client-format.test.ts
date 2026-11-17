import { describe, expect, it } from "vitest";
import {
  coverUrl,
  formatBytes,
  formatDate,
  formatPlaytime,
  formatRelativeTime,
  initialsFor,
  ownershipLabel,
  reviewCardLabel,
  reviewSummaryLabel,
  reviewTone,
} from "../../src/client/format.ts";

describe("playtime formatting", () => {
  it("keeps the API in minutes and formats hours for display", () => {
    expect(formatPlaytime(0)).toBe("Not played");
    expect(formatPlaytime(45)).toBe("45 min");
    expect(formatPlaytime(60)).toBe("1 h");
    expect(formatPlaytime(612)).toBe("10 h 12 m");
  });
});

describe("cover presentation", () => {
  it("derives the cover from the App ID and tinted initials from the name", () => {
    expect(coverUrl(620)).toContain("/620/header.jpg");
    expect(coverUrl(620, "library")).toContain("/620/library_600x900.jpg");
    expect(initialsFor("Portal 2")).toBe("P2");
    expect(initialsFor("Counter-Strike 2")).toBe("CS");
    expect(initialsFor("")).toBe("?");
  });

  it("formats byte counts and dates with an em dash for missing values", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(13_200_000_000)).toBe("13.2 GB");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("2024-04-04T03:06:40Z")).toBe("4 Apr 2024");
  });
});

describe("relative freshness", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");

  it("formats the status card's dataAsOf time coarsely", () => {
    expect(formatRelativeTime(null, now)).toBe("no data yet");
    expect(formatRelativeTime("2026-11-15T11:59:30Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-11-15T11:45:00Z", now)).toBe("15 min ago");
    expect(formatRelativeTime("2026-11-15T09:00:00Z", now)).toBe("3 h ago");
    expect(formatRelativeTime("2026-11-12T12:00:00Z", now)).toBe("3 d ago");
  });
});

describe("domain labels", () => {
  it("labels Ownership and review tones", () => {
    expect(ownershipLabel("owned")).toBe("Owned");
    expect(ownershipLabel("local_only")).toBe("Local only");
    expect(ownershipLabel("unknown")).toBe("Unknown ownership");
    expect(reviewTone(null)).toBe("none");
    expect(reviewTone(95)).toBe("great");
    expect(reviewTone(80)).toBe("good");
    expect(reviewTone(55)).toBe("mixed");
    expect(reviewTone(20)).toBe("bad");
  });

  it("labels reviews and distinguishes a known zero from an unknown count", () => {
    expect(reviewSummaryLabel(98, "Overwhelmingly Positive", 1000)).toBe(
      "98% · Overwhelmingly Positive · 1,000 reviews",
    );
    expect(reviewSummaryLabel(null, null, 0)).toBe("No user reviews");
    expect(reviewSummaryLabel(null, null, null)).toBe("Reviews unavailable");
    expect(reviewCardLabel("Overwhelmingly Positive", 1000)).toBe(
      "Overwhelmingly Positive · 1,000 reviews",
    );
    expect(reviewCardLabel(null, 0)).toBe("No user reviews");
    expect(reviewCardLabel(null, null)).toBe("Reviews unavailable");
  });
});
