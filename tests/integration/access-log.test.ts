import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../../src/server/index.ts";

const CLIENT_DIR = join(import.meta.dirname, "..", "fixtures", "client");
const running: RunningServer[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
});

function temp(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${randomUUID()}`);
}

describe("access log", () => {
  it("AC-P7 omits query strings and redacts a key parameter", async () => {
    const sink = new PassThrough();
    let output = "";
    sink.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const dataDir = temp("game-cat-access-log");
    const server = await createServer({
      dataDir,
      port: 0,
      openBrowser: false,
      env: {} as NodeJS.ProcessEnv,
      homedir: mkdtempSync(join(tmpdir(), "game-cat-home-")),
      platform: "linux",
      clientDir: CLIENT_DIR,
      logLevel: "info",
      logToStderr: false,
      logSink: sink,
      startupRefresh: false,
    });
    running.push(server);

    const response = await fetch(`${server.url}api/status?key=SUPER_SECRET_KEY&verbose=1`, {
      headers: { "x-test": "AccountName" },
    });
    expect(response.status).toBe(200);
    await server.close();
    running.pop();

    expect(output).not.toContain("SUPER_SECRET_KEY");
    expect(output).not.toContain("verbose=1");
    expect(output).not.toContain("AccountName");
    const lines = output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const access = lines.find((line) => line.msg === "request");
    expect(access).toMatchObject({ method: "GET", path: "/api/status", status: 200 });
  });
});
