import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config/load.ts";
import { StartupError } from "../../src/server/errors.ts";

const base = {
  env: {} as NodeJS.ProcessEnv,
  platform: "linux" as NodeJS.Platform,
  homedir: "/home/tester",
  cwd: "/work",
};

function tempDataDir(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-config-"));
  if (config !== undefined) {
    writeFileSync(
      join(dir, "config.json"),
      typeof config === "string" ? config : JSON.stringify(config),
      { mode: 0o600 },
    );
  }
  return dir;
}

function expectStartupError(fn: () => unknown, code: string, messagePart?: string): StartupError {
  try {
    fn();
    throw new Error("expected a StartupError");
  } catch (error) {
    expect(error).toBeInstanceOf(StartupError);
    const startup = error as StartupError;
    expect(startup.code).toBe(code);
    if (messagePart !== undefined) {
      expect(startup.message).toContain(messagePart);
    }
    return startup;
  }
}

describe("configuration defaults and locations", () => {
  it("uses the Linux XDG data directory and documented defaults", () => {
    const config = loadConfig({ ...base, env: {} });
    expect(config.dataDir).toBe("/home/tester/.local/share/game-cat");
    expect(config.port).toBe(4780);
    expect(config.portSource).toBe("default");
    expect(config.openBrowser).toBe(true);
    expect(config.logLevel).toBe("info");
    expect(config.steamApiKey).toBeNull();
    expect(config.steamApiKeySource).toBe("none");
    expect(config.steamRoot).toBeNull();
    expect(config.steamId64).toBeNull();
    expect(config.configFileExists).toBe(false);
  });

  it("honors XDG_DATA_HOME on Linux", () => {
    const config = loadConfig({ ...base, env: { XDG_DATA_HOME: "/xdg/data" } });
    expect(config.dataDir).toBe("/xdg/data/game-cat");
  });

  it("uses the macOS application support directory", () => {
    const config = loadConfig({ ...base, platform: "darwin", env: {} });
    expect(config.dataDir).toBe("/home/tester/Library/Application Support/game-cat");
  });

  it("uses LOCALAPPDATA on Windows", () => {
    const config = loadConfig({
      ...base,
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    });
    expect(config.dataDir).toContain("game-cat");
    expect(config.dataDir).toContain("AppData");
  });

  it("AC-C4 puts the data dir override above the environment and expands ~", () => {
    const config = loadConfig({
      ...base,
      env: { GAME_CAT_DATA_DIR: "/env/game-cat" },
      overrides: { dataDir: "~/custom-cat" },
    });
    expect(config.dataDir).toBe("/home/tester/custom-cat");
  });

  it("AC-C4 resolves a relative data dir against the working directory", () => {
    const config = loadConfig({ ...base, overrides: { dataDir: ".data" } });
    expect(config.dataDir).toBe("/work/.data");
  });
});

describe("configuration precedence", () => {
  it("AC-C7 applies CLI over environment over file over defaults for every setting", () => {
    const dir = tempDataDir({
      port: 5000,
      openBrowser: false,
      logLevel: "warn",
      steamRoot: "/file/Steam",
      steamId64: "76561198000000001",
      steamApiKey: "file-key",
    });
    const fileOnly = loadConfig({ ...base, env: {}, overrides: { dataDir: dir } });
    expect(fileOnly.port).toBe(5000);
    expect(fileOnly.openBrowser).toBe(false);
    expect(fileOnly.logLevel).toBe("warn");
    expect(fileOnly.steamRoot).toBe("/file/Steam");
    expect(fileOnly.steamId64).toBe("76561198000000001");
    expect(fileOnly.steamApiKeySource).toBe("file");

    const withEnv = loadConfig({
      ...base,
      env: {
        GAME_CAT_PORT: "5001",
        GAME_CAT_OPEN_BROWSER: "true",
        GAME_CAT_LOG_LEVEL: "error",
        GAME_CAT_STEAM_ROOT: "/env/Steam",
        GAME_CAT_STEAM_ID64: "76561198000000002",
        GAME_CAT_STEAM_API_KEY: "env-key",
      },
      overrides: { dataDir: dir },
    });
    expect(withEnv.port).toBe(5001);
    expect(withEnv.portSource).toBe("env");
    expect(withEnv.openBrowser).toBe(true);
    expect(withEnv.logLevel).toBe("error");
    expect(withEnv.steamRoot).toBe("/env/Steam");
    expect(withEnv.steamId64).toBe("76561198000000002");
    expect(withEnv.steamApiKey).toBe("env-key");
    expect(withEnv.steamApiKeySource).toBe("env");

    const withCli = loadConfig({
      ...base,
      env: {
        GAME_CAT_PORT: "5001",
        GAME_CAT_OPEN_BROWSER: "true",
        GAME_CAT_LOG_LEVEL: "error",
      },
      overrides: {
        dataDir: dir,
        port: 0,
        openBrowser: false,
        logLevel: "debug",
      },
    });
    expect(withCli.port).toBe(0);
    expect(withCli.portSource).toBe("cli");
    expect(withCli.openBrowser).toBe(false);
    expect(withCli.logLevel).toBe("debug");
    expect(withCli.logLevelSource).toBe("cli");
  });

  it("accepts only the documented boolean spellings", () => {
    for (const [value, expected] of [
      ["1", true],
      ["TRUE", true],
      ["0", false],
      ["False", false],
    ] as const) {
      const config = loadConfig({
        ...base,
        env: { GAME_CAT_OPEN_BROWSER: value },
        overrides: { dataDir: tempDataDir() },
      });
      expect(config.openBrowser).toBe(expected);
    }
  });
});

describe("configuration validation", () => {
  it("AC-C6 rejects invalid JSON without rewriting the file", () => {
    const dir = tempDataDir("{ not json");
    expectStartupError(
      () => loadConfig({ ...base, overrides: { dataDir: dir } }),
      "CONFIG_INVALID",
    );
  });

  it("AC-C6 rejects an unknown key and names the path", () => {
    const dir = tempDataDir({ prot: 1234 });
    const error = expectStartupError(
      () => loadConfig({ ...base, overrides: { dataDir: dir } }),
      "CONFIG_INVALID",
    );
    expect(error.message).toContain("prot");
  });

  it("rejects every invalid file value", () => {
    const cases: Array<Record<string, unknown>> = [
      { port: "4780" },
      { port: 70000 },
      { port: -1 },
      { port: 1.5 },
      { openBrowser: "yes" },
      { logLevel: "verbose" },
      { steamId64: "1234" },
      { steamRoot: "relative/Steam" },
      { steamApiKey: "" },
      { steamApiKey: 42 },
    ];
    for (const value of cases) {
      const dir = tempDataDir(value);
      const error = expectStartupError(
        () => loadConfig({ ...base, overrides: { dataDir: dir } }),
        "CONFIG_INVALID",
      );
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("AC-C6 rejects invalid environment values", () => {
    const envCases: Array<NodeJS.ProcessEnv> = [
      { GAME_CAT_PORT: "abc" },
      { GAME_CAT_PORT: "70000" },
      { GAME_CAT_OPEN_BROWSER: "yes" },
      { GAME_CAT_LOG_LEVEL: "verbose" },
      { GAME_CAT_STEAM_ID64: "123" },
      { GAME_CAT_STEAM_API_KEY: "" },
      { GAME_CAT_STEAM_ROOT: "relative" },
      { GAME_CAT_DATA_DIR: "" },
    ];
    for (const env of envCases) {
      expectStartupError(
        () => loadConfig({ ...base, env, overrides: { dataDir: tempDataDir() } }),
        "CONFIG_INVALID",
      );
    }
  });

  it("validates programmatic overrides the same way", () => {
    expectStartupError(
      () =>
        loadConfig({
          ...base,
          overrides: { dataDir: tempDataDir(), port: "nope" as unknown as number },
        }),
      "CONFIG_INVALID",
    );
    expectStartupError(
      () =>
        loadConfig({
          ...base,
          overrides: { dataDir: tempDataDir(), logLevel: "loud" },
        }),
      "CONFIG_INVALID",
    );
  });

  it("reads a 17-digit SteamID64 and a key from the file", () => {
    const dir = tempDataDir({ steamId64: "76561198000000000", steamApiKey: "secret" });
    const config = loadConfig({ ...base, overrides: { dataDir: dir } });
    expect(config.steamId64).toBe("76561198000000000");
    expect(config.steamApiKey).toBe("secret");
    expect(config.steamApiKeySource).toBe("file");
  });
});
