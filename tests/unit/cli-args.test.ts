import { describe, expect, it } from "vitest";
import { CliUsageError } from "../../src/server/errors.ts";
import { parseCliArgs, USAGE } from "../../src/server/cli-args.ts";

describe("CLI arguments", () => {
  it("returns no overrides by default", () => {
    const parsed = parseCliArgs([]);
    expect(parsed.help).toBe(false);
    expect(parsed.version).toBe(false);
    expect(parsed.options).toEqual({});
  });

  it.each([
    [["--data-dir=/tmp/game-cat"], { dataDir: "/tmp/game-cat" }],
    [["--data-dir", "/tmp/game-cat"], { dataDir: "/tmp/game-cat" }],
    [["--port=0"], { port: "0" }],
    [["--port", "0"], { port: "0" }],
    [["--log-level=debug"], { logLevel: "debug" }],
    [["--log-level", "debug"], { logLevel: "debug" }],
    [["--no-open"], { openBrowser: false }],
  ])("parses %j", (argv, expected) => {
    expect(parseCliArgs(argv).options).toEqual(expected);
  });

  it("parses the documented flags together in both value forms", () => {
    const parsed = parseCliArgs([
      "--data-dir",
      "/tmp/game-cat",
      "--port=0",
      "--no-open",
      "--log-level",
      "debug",
    ]);
    expect(parsed.options).toEqual({
      dataDir: "/tmp/game-cat",
      port: "0",
      openBrowser: false,
      logLevel: "debug",
    });
  });

  it("supports --help, -h, --version, and -v", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(parseCliArgs(["--version"]).version).toBe(true);
    expect(parseCliArgs(["-v"]).version).toBe(true);
  });

  it("rejects unknown flags and stray arguments as usage errors", () => {
    for (const argv of [["--wat"], ["start"], ["--port"]]) {
      expect(() => parseCliArgs(argv)).toThrowError(CliUsageError);
    }
  });

  it("rejects missing and empty values as usage errors", () => {
    for (const argv of [
      ["--data-dir"],
      ["--data-dir="],
      ["--port"],
      ["--port="],
      ["--log-level"],
      ["--log-level="],
    ]) {
      expect(() => parseCliArgs(argv)).toThrowError(CliUsageError);
    }
  });

  it("leaves value validation to the config layer", () => {
    expect(parseCliArgs(["--port", "-1"]).options).toEqual({ port: "-1" });
  });

  it("documents every flag in the help text", () => {
    for (const flag of [
      "--data-dir",
      "--port",
      "--no-open",
      "--log-level",
      "--help",
      "--version",
    ]) {
      expect(USAGE).toContain(flag);
    }
    expect(USAGE).toContain("Usage: game-cat [options]");
    expect(USAGE).toContain("Environment:");
    expect(USAGE).toContain("GAME_CAT_DATA_DIR");
  });
});
