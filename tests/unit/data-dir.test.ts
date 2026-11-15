import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertDataDirOutsideSteam, prepareDataDir } from "../../src/server/config/data-dir.ts";
import { StartupError } from "../../src/server/errors.ts";

function makeTempRoot(): string {
  return join(process.env.TMPDIR ?? "/tmp", `game-cat-datadir-${process.pid}-${randomUUID()}`);
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function expectCode(fn: () => unknown, code: string): StartupError {
  try {
    fn();
    throw new Error("expected StartupError");
  } catch (error) {
    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).code).toBe(code);
    return error as StartupError;
  }
}

describe("data directory layout", () => {
  it("AC-C2 creates the directory, config.json, backups/, and logs/", () => {
    const dataDir = join(makeTempRoot(), "nested", "game-cat");
    const prepared = prepareDataDir({
      dataDir,
      configPath: join(dataDir, "config.json"),
      configFileExists: false,
      keySource: "none",
    });

    expect(prepared.created).toBe(true);
    expect(existsSync(join(dataDir, "config.json"))).toBe(true);
    expect(existsSync(join(dataDir, "backups"))).toBe(true);
    expect(existsSync(join(dataDir, "logs"))).toBe(true);
    expect(readdirSync(dataDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"))).toEqual({});
  });

  it("AC-C3 creates the directory and its files with POSIX modes", () => {
    if (process.platform === "win32") {
      return;
    }
    const dataDir = join(makeTempRoot(), "game-cat");
    prepareDataDir({
      dataDir,
      configPath: join(dataDir, "config.json"),
      configFileExists: false,
      keySource: "none",
    });

    expect(modeOf(dataDir)).toBe(0o700);
    expect(modeOf(join(dataDir, "backups"))).toBe(0o700);
    expect(modeOf(join(dataDir, "logs"))).toBe(0o700);
    expect(modeOf(join(dataDir, "config.json"))).toBe(0o600);
  });

  it("AC-C3 tightens an existing group- or world-readable data directory", () => {
    if (process.platform === "win32") {
      return;
    }
    const dataDir = join(makeTempRoot(), "game-cat");
    mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    chmodSync(dataDir, 0o755);

    prepareDataDir({
      dataDir,
      configPath: join(dataDir, "config.json"),
      configFileExists: false,
      keySource: "none",
    });

    expect(modeOf(dataDir)).toBe(0o700);
  });

  it("does not overwrite an existing config.json", () => {
    const dataDir = join(makeTempRoot(), "game-cat");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "config.json"), '{"port":5000}', { mode: 0o600 });

    prepareDataDir({
      dataDir,
      configPath: join(dataDir, "config.json"),
      configFileExists: true,
      keySource: "none",
    });

    expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe('{"port":5000}');
  });

  it("AC-C3 tightens a group- or world-readable config.json", () => {
    if (process.platform === "win32") {
      return;
    }
    const dataDir = join(makeTempRoot(), "game-cat");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "config.json"), "{}", { mode: 0o644 });
    chmodSync(join(dataDir, "config.json"), 0o644);

    prepareDataDir({
      dataDir,
      configPath: join(dataDir, "config.json"),
      configFileExists: true,
      keySource: "file",
    });

    expect(modeOf(join(dataDir, "config.json"))).toBe(0o600);
  });

  it("AC-C3 exits CONFIG_PERMISSIONS when a file key cannot be tightened", () => {
    if (process.platform === "win32") {
      return;
    }
    const dataDir = join(makeTempRoot(), "game-cat");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "config.json"), '{"steamApiKey":"secret"}', {
      mode: 0o644,
    });
    chmodSync(join(dataDir, "config.json"), 0o644);

    expectCode(
      () =>
        prepareDataDir({
          dataDir,
          configPath: join(dataDir, "config.json"),
          configFileExists: true,
          keySource: "file",
          chmod: () => {
            throw new Error("read-only filesystem");
          },
        }),
      "CONFIG_PERMISSIONS",
    );
  });

  it("only warns when the key comes from the environment", () => {
    if (process.platform === "win32") {
      return;
    }
    const dataDir = join(makeTempRoot(), "game-cat");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "config.json"), "{}", { mode: 0o644 });
    chmodSync(join(dataDir, "config.json"), 0o644);

    const prepared = prepareDataDir({
      dataDir,
      configPath: join(dataDir, "config.json"),
      configFileExists: true,
      keySource: "env",
      chmod: () => {
        throw new Error("read-only filesystem");
      },
    });
    expect(prepared.warnings.length).toBeGreaterThan(0);
  });

  it("AC-C5 refuses a data directory inside the Steam root", () => {
    expectCode(
      () => assertDataDirOutsideSteam("/steam/root/game-cat", "/steam/root"),
      "DATA_DIR_IN_STEAM",
    );
    expectCode(() => assertDataDirOutsideSteam("/steam/root", "/steam/root"), "DATA_DIR_IN_STEAM");
    expect(() =>
      assertDataDirOutsideSteam("/home/tester/.local/share/game-cat", "/steam/root"),
    ).not.toThrow();
  });

  it("maps an unwritable path to DATA_DIR_NOT_WRITABLE", () => {
    const filePath = join(makeTempRoot(), "not-a-directory");
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, "file");

    expectCode(
      () =>
        prepareDataDir({
          dataDir: join(filePath, "data"),
          configPath: join(filePath, "data", "config.json"),
          configFileExists: false,
          keySource: "none",
        }),
      "DATA_DIR_NOT_WRITABLE",
    );
  });
});
