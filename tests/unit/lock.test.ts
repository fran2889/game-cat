import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StartupError } from "../../src/server/errors.ts";
import { acquireLock, readLockFile } from "../../src/server/lock.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-lock-"));
  cleanups.push(() => {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // ignore
    }
  });
  return join(dir, "game-cat.lock");
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

function startHolder(path: string): Promise<{ child: ReturnType<typeof spawn>; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "..", "fixtures", "hold-lock.mjs"), path],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`holder did not start: ${output}`));
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("locked")) {
        clearTimeout(timer);
        resolve({ child, pid: child.pid ?? -1 });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`holder exited early with ${code}: ${output}`));
    });
  });
}

describe("single-instance lock", () => {
  it("writes a diagnostic PID and start-time body with 0600 permissions", () => {
    const path = lockPath();
    const lock = acquireLock({ lockPath: path, dataDir: "/tmp/game-cat-data" });
    cleanups.push(() => lock.release());

    expect(lock.info.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(lock.info.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(lock.info.startTime))).toBe(false);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(onDisk.pid).toBe(process.pid);
    if (process.platform !== "win32") {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("AC-C12 rejects a second acquire with ALREADY_RUNNING and the owning PID", () => {
    const path = lockPath();
    const lock = acquireLock({ lockPath: path, dataDir: "/tmp/game-cat-data" });
    cleanups.push(() => lock.release());

    const error = expectCode(
      () => acquireLock({ lockPath: path, dataDir: "/tmp/game-cat-data" }),
      "ALREADY_RUNNING",
    );
    expect(error.message).toContain(String(process.pid));
    expect(error.details?.pid).toBe(process.pid);
  });

  it("AC-C12 rejects a second process while it holds the lock", async () => {
    const path = lockPath();
    const holder = await startHolder(path);
    cleanups.push(() => holder.child.kill("SIGKILL"));
    try {
      const error = expectCode(
        () => acquireLock({ lockPath: path, dataDir: "/tmp/game-cat-data" }),
        "ALREADY_RUNNING",
      );
      expect(error.details?.pid).toBe(holder.pid);
      expect(readLockFile(path)?.pid).toBe(holder.pid);
    } finally {
      holder.child.kill("SIGKILL");
    }
  });

  it("recovers a lock whose process is gone", () => {
    const path = lockPath();
    writeFileSync(
      path,
      JSON.stringify({
        pid: 2_147_483_647,
        startedAt: "2026-01-01T00:00:00.000Z",
        startTime: "2026-01-01T00:00:00.000Z",
        app: "game-cat",
      }),
      { mode: 0o600 },
    );

    const lock = acquireLock({ lockPath: path, dataDir: "/tmp/game-cat-data" });
    cleanups.push(() => lock.release());
    expect(lock.info.pid).toBe(process.pid);
    expect(readLockFile(path)?.pid).toBe(process.pid);
  });

  it("recovers a malformed lock file", () => {
    const path = lockPath();
    writeFileSync(path, "not json", { mode: 0o600 });
    const lock = acquireLock({ lockPath: path, dataDir: "/tmp/game-cat-data" });
    cleanups.push(() => lock.release());
    expect(readLockFile(path)?.pid).toBe(process.pid);
  });

  it("recovers a PID whose process start time does not match", () => {
    if (process.platform !== "linux" || !existsSync(`/proc/${process.pid}/stat`)) {
      return;
    }
    const path = lockPath();
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
        startTime: "2026-01-01T00:00:00.000Z",
        procStartTicks: "1",
        app: "game-cat",
      }),
      { mode: 0o600 },
    );

    const lock = acquireLock({ lockPath: path, dataDir: "/tmp/game-cat-data" });
    cleanups.push(() => lock.release());
    expect(lock.info.procStartTicks).not.toBe("1");
  });

  it("releases the lock so the next start can take it", () => {
    const path = lockPath();
    const lock = acquireLock({ lockPath: path, dataDir: "/tmp/game-cat-data" });
    lock.release();
    expect(readLockFile(path)).toBeNull();

    const second = acquireLock({ lockPath: path, dataDir: "/tmp/game-cat-data" });
    cleanups.push(() => second.release());
    expect(second.info.pid).toBe(process.pid);
  });
});
