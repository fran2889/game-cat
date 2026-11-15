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

  it("parses the documented flags in both value forms", () => {
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
  });
});
