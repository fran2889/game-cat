import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Agent as HttpAgent, get as httpGet } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, startServer, type RunningServer } from "../../src/server/index.ts";
import { StartupError } from "../../src/server/errors.ts";
import { readLockFile } from "../../src/server/lock.ts";

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

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "game-cat-home-"));
}

function baseOptions(dataDir: string, home = tempHome()) {
  return {
    dataDir,
    port: 0,
    openBrowser: false,
    env: {} as NodeJS.ProcessEnv,
    homedir: home,
    platform: "linux" as NodeJS.Platform,
    clientDir: CLIENT_DIR,
    logLevel: "error",
    logToStderr: false,
  };
}

async function start(options: Parameters<typeof createServer>[0]): Promise<RunningServer> {
  const server = await createServer(options);
  running.push(server);
  return server;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<StartupError> {
  try {
    await promise;
    throw new Error("expected a StartupError");
  } catch (error) {
    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).code).toBe(code);
    return error as StartupError;
  }
}

describe("programmatic startup", () => {
  it("AC-P8 listens on an OS-assigned port and serves /api/status", async () => {
    const dataDir = temp("game-cat-start");
    const server = await start(baseOptions(dataDir));

    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
    expect(server.config.port).toBe(server.port);
    expect(server.config.listeningUrl).toBe(server.url);

    const response = await fetch(`${server.url}api/status`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { steam: { state: string } } };
    expect(body.data.steam.state).toBe("not_found");
  });

  it("AC-C2/C3 creates the documented layout before listening", async () => {
    const dataDir = temp("game-cat-layout");
    await start(baseOptions(dataDir));

    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(join(dataDir, "config.json"))).toBe(true);
    expect(existsSync(join(dataDir, "backups"))).toBe(true);
    expect(existsSync(join(dataDir, "logs"))).toBe(true);
    expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(true);
    expect(existsSync(join(dataDir, "logs", "game-cat.log"))).toBe(true);
    // #22 owns the database and migration runner.
    expect(existsSync(join(dataDir, "game-cat.sqlite"))).toBe(true);

    if (process.platform !== "win32") {
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dataDir, "config.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "logs", "game-cat.log")).mode & 0o777).toBe(0o600);
    }
  });

  it("AC-C11 --port 0 reports the actual OS-assigned port", async () => {
    const server = await start({ ...baseOptions(temp("game-cat-port0")), port: "0" });
    expect(server.port).toBeGreaterThan(1023);
    const response = await fetch(`${server.url}api/status`);
    expect(response.status).toBe(200);
  });

  it("AC-C10 exits PORT_IN_USE without trying another port and releases the lock", async () => {
    const occupied = createNetServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    const busyPort = typeof address === "object" && address !== null ? address.port : 0;
    const dataDir = temp("game-cat-busy");

    try {
      const error = await expectCode(
        createServer({ ...baseOptions(dataDir), port: busyPort }),
        "PORT_IN_USE",
      );
      expect(error.message).toContain(String(busyPort));
      expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }

    const server = await start(baseOptions(dataDir));
    expect(server.port).toBeGreaterThan(0);
  });

  it("AC-C12 rejects a second server on the same data directory", async () => {
    const dataDir = temp("game-cat-single");
    const first = await start(baseOptions(dataDir));
    const error = await expectCode(createServer(baseOptions(dataDir)), "ALREADY_RUNNING");
    expect(error.details?.pid).toBe(process.pid);
    expect(readLockFile(join(dataDir, "game-cat.lock"))?.pid).toBe(process.pid);
    expect((await fetch(`${first.url}api/status`)).status).toBe(200);
  });

  it("AC-C13 runs two data directories independently", async () => {
    const first = await start(baseOptions(temp("game-cat-a")));
    const second = await start(baseOptions(temp("game-cat-b")));
    expect(first.port).not.toBe(second.port);
    expect((await fetch(`${first.url}api/status`)).status).toBe(200);
    expect((await fetch(`${second.url}api/status`)).status).toBe(200);
  });

  it("recovers a stale lock on startup", async () => {
    const dataDir = temp("game-cat-stale");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dataDir, "game-cat.lock"),
      JSON.stringify({
        pid: 2_147_483_647,
        startedAt: "2020-01-01T00:00:00.000Z",
        startTime: "2020-01-01T00:00:00.000Z",
        app: "game-cat",
      }),
      { mode: 0o600 },
    );

    const server = await start(baseOptions(dataDir));
    expect(readLockFile(join(dataDir, "game-cat.lock"))?.pid).toBe(process.pid);
    expect((await fetch(`${server.url}api/status`)).status).toBe(200);
  });

  it("close() is idempotent, releases the lock, and allows a restart", async () => {
    const dataDir = temp("game-cat-close");
    const server = await start(baseOptions(dataDir));
    const url = server.url;

    await server.close();
    await server.close();
    expect(server.database.raw.open).toBe(false);
    expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
    await expect(fetch(`${url}api/status`)).rejects.toThrow();

    const restarted = await start(baseOptions(dataDir));
    expect((await fetch(`${restarted.url}api/status`)).status).toBe(200);
  });

  it("close() does not wait for an idle keep-alive HTTP connection", async () => {
    const server = await start(baseOptions(temp("game-cat-keepalive")));
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    try {
      await new Promise<void>((resolve, reject) => {
        const request = httpGet(`${server.url}api/status`, { agent }, (response) => {
          response.resume();
          response.on("end", () => resolve());
        });
        request.on("error", reject);
      });

      const startedAt = Date.now();
      await server.close();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      agent.destroy();
    }
  });

  it("startServer removes its signal handlers when close() resolves", async () => {
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGHUP: process.listenerCount("SIGHUP"),
    };
    const server = await startServer(baseOptions(temp("game-cat-signals")));
    running.push(server);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM + 1);
    if (process.platform !== "win32") {
      expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP + 1);
    }

    await server.close();
    running.pop();
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP);
  });
});

describe("startup guards", () => {
  it("AC-C1 refuses an old Node before creating anything", async () => {
    const dataDir = temp("game-cat-node");
    const error = await expectCode(
      createServer({ ...baseOptions(dataDir), nodeVersion: "22.11.0" }),
      "NODE_VERSION",
    );
    expect(error.message).toContain("22.11.0");
    expect(existsSync(dataDir)).toBe(false);
  });

  it("AC-C6 exits CONFIG_INVALID before the lock or log file exists", async () => {
    const dataDir = temp("game-cat-bad-config");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "config.json"), '{"porrt": 1234}', { mode: 0o600 });

    await expectCode(createServer(baseOptions(dataDir)), "CONFIG_INVALID");
    expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
    expect(existsSync(join(dataDir, "logs"))).toBe(false);
    expect(existsSync(join(dataDir, "game-cat.sqlite"))).toBe(false);
  });

  it("AC-C5 refuses a data directory inside the Steam root before creating it", async () => {
    const home = tempHome();
    const steamRoot = join(home, "Steam");
    mkdirSync(join(steamRoot, "config"), { recursive: true });
    const dataDir = join(steamRoot, "game-cat-data");

    const error = await expectCode(
      createServer({
        ...baseOptions(dataDir, home),
        steamRoot,
      }),
      "DATA_DIR_IN_STEAM",
    );
    expect(error.message).toContain(steamRoot);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("does not write into the Steam tree when the configured root is missing", async () => {
    const home = tempHome();
    const steamRoot = join(home, "MissingSteam");
    const dataDir = join(home, "game-cat-data");

    await start({ ...baseOptions(dataDir, home), steamRoot });
    expect(existsSync(steamRoot)).toBe(false);
  });
});

describe("startup logging", () => {
  it("logs the documented readiness line without the Steam key", async () => {
    const sink = new PassThrough();
    let output = "";
    sink.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const dataDir = temp("game-cat-logline");
    await start({
      ...baseOptions(dataDir),
      logLevel: "info",
      logSink: sink,
      steamApiKey: "SUPER_SECRET_STEAM_KEY",
    });

    const lines = output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const ready = lines.find((line) => line.msg === "ready");
    expect(ready).toBeDefined();
    expect(ready?.dataDir).toBe(dataDir);
    expect(ready?.url).toContain("http://127.0.0.1:");
    expect(ready?.nodeVersion).toBe(process.versions.node);
    expect(ready?.schemaVersion).toBe(1);
    expect(ready?.logFile).toBe(join(dataDir, "logs", "game-cat.log"));
    expect(output).not.toContain("SUPER_SECRET_STEAM_KEY");
  });

  it("continues when the log file cannot be opened", async () => {
    const dataDir = temp("game-cat-logfail");
    const server = await start({
      ...baseOptions(dataDir),
      logFilePath: dataDir, // a directory: opening it as a file fails
    });
    expect((await fetch(`${server.url}api/status`)).status).toBe(200);
  });
});
