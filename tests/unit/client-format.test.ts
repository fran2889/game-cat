import { describe, expect, it } from "vitest";
import {
  coverUrl,
  formatBytes,
  formatDate,
  formatPlaytime,
  initialsFor,
  ownershipLabel,
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
});
