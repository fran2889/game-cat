import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, redactUrl } from "../../src/server/logging/logger.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "game-cat-log-"));
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("logging", () => {
  it("writes JSON lines to <data-dir>/logs/game-cat.log", async () => {
    const dir = tempDir();
    const filePath = join(dir, "logs", "game-cat.log");
    const appLogger = createLogger({ level: "info", filePath, stderr: false });
    appLogger.logger.info({ requestId: "rid-1" }, "started");
    await appLogger.close();

    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe("started");
    expect(lines[0]?.requestId).toBe("rid-1");
    if (process.platform !== "win32") {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("redacts the Steam key and AccountName from every log line", async () => {
    const dir = tempDir();
    const filePath = join(dir, "game-cat.log");
    const appLogger = createLogger({ level: "info", filePath, stderr: false });
    appLogger.logger.info(
      {
        steamApiKey: "super-secret-key",
        accountName: "tester_login",
        nested: { key: "another-secret", AccountName: "tester_login" },
        headers: { authorization: "Bearer nope", cookie: "session=nope" },
      },
      "config loaded",
    );
    await appLogger.close();

    const text = readFileSync(filePath, "utf8");
    expect(text).not.toContain("super-secret-key");
    expect(text).not.toContain("tester_login");
    expect(text).not.toContain("another-secret");
    expect(text).not.toContain("Bearer nope");
    expect(text).not.toContain("session=nope");
    expect(text).toContain("[REDACTED]");
  });

  it("omits query strings from logged paths and redacts key parameters", () => {
    expect(redactUrl("/api/status?verbose=1")).toBe("/api/status");
    expect(redactUrl("/api/steam?key=SECRET&x=1")).toBe("/api/steam");
    const redacted = redactUrl("/upstream?appid=1&key=SECRET", { keepQuery: true });
    expect(redacted).not.toContain("SECRET");
    expect(redacted).toContain("appid=1");
  });

  it("falls back to the stream when the log file cannot be opened", async () => {
    const dir = tempDir();
    const sink = new PassThrough();
    let output = "";
    sink.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const appLogger = createLogger({
      level: "info",
      filePath: dir, // a directory: open for append fails
      stderr: false,
      stream: sink,
    });
    expect(appLogger.fileError).not.toBeNull();
    appLogger.logger.info("still alive");
    await appLogger.close();
    expect(output).toContain("still alive");
  });

  it("prints human-readable output on a TTY", async () => {
    const sink = new PassThrough();
    let output = "";
    sink.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const appLogger = createLogger({
      level: "info",
      tty: true,
      stderr: false,
      stream: sink,
      filePath: null,
    });
    appLogger.logger.info({ requestId: "rid-tty" }, "hello tty");
    await appLogger.close();
    expect(output).toContain("hello tty");
    expect(output.trimStart().startsWith("{")).toBe(false);
  });

  it("rotates the log file at the configured size, keeping three files", async () => {
    const dir = tempDir();
    const filePath = join(dir, "game-cat.log");
    const appLogger = createLogger({
      level: "info",
      filePath,
      stderr: false,
      maxFileSizeBytes: 300,
      keepFiles: 3,
    });
    for (let index = 0; index < 20; index += 1) {
      appLogger.logger.info({ index, payload: "x".repeat(40) }, "line");
    }
    await appLogger.close();

    const files = readdirSync(dir).filter((name) => name.startsWith("game-cat.log"));
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files).toContain("game-cat.log");
    expect(files).toContain("game-cat.log.1");
    for (const file of files) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        if (line.trim() !== "") {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      }
    }
  });
});
