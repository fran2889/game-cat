import { describe, expect, it } from "vitest";
import { validateRules } from "../../src/shared/rules.ts";
import {
  fixtureChecksum,
  generatePerfGames,
  PERF_1300,
  PERF_20000,
  readRulesFixture,
} from "../../scripts/perf/fixtures.ts";

/**
 * The performance baseline is only meaningful when the fixture is fixed.
 * These hashes pin the committed generator seed; update them deliberately if
 * the fixture ever changes and record the new p50/p95 results.
 */
const EXPECTED_20000 = "0512355f39b86eb75bc6d5fc34352e2d5183eb3eceea8f040297674ffe764e46";
const EXPECTED_1300 = "0903cdf5053b1a3cbdeabab72457687e68a31e27822f9bd973706f5a416e0b4b";

describe("performance fixtures", () => {
  it("generates the same 20,000-Game fixture from the committed seed", () => {
    const first = generatePerfGames(PERF_20000.games, PERF_20000.seed, PERF_20000.baseAppId);
    const second = generatePerfGames(PERF_20000.games, PERF_20000.seed, PERF_20000.baseAppId);
    expect(first).toHaveLength(20_000);
    expect(fixtureChecksum(first)).toBe(EXPECTED_20000);
    expect(fixtureChecksum(second)).toBe(EXPECTED_20000);
    expect(first[0]?.appId).toBe(PERF_20000.baseAppId);
    expect(first.at(-1)?.appId).toBe(PERF_20000.baseAppId + 19_999);
  });

  it("generates the same 1,300-Game fixture from the committed seed", () => {
    const games = generatePerfGames(PERF_1300.games, PERF_1300.seed, PERF_1300.baseAppId);
    expect(games).toHaveLength(1_300);
    expect(fixtureChecksum(games)).toBe(EXPECTED_1300);
  });

  it("commits a valid 100-Rule Smart Collection fixture", () => {
    const fixture = readRulesFixture();
    const validated = validateRules(fixture.rules);
    expect(fixture.rules).toHaveLength(100);
    expect(validated.fieldErrors).toEqual({});
    expect(validated.rules).toHaveLength(100);
    expect(fixture.rules.filter((rule) => rule.prefix === "AND")).toHaveLength(34);
    expect(fixture.rules.filter((rule) => rule.prefix === "OR")).toHaveLength(33);
    expect(fixture.rules.filter((rule) => rule.prefix === "NOT")).toHaveLength(33);
  });
});
