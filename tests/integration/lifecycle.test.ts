import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "lifecycle-server.ts");

const children: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  while (children.length > 0) {
    const child = children.pop();
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
});

interface Fixture {
  child: ReturnType<typeof spawn>;
  stdout: () => string;
  stderr: () => string;
  dataDir: string;
  exit: Promise<number | null>;
  waitForOutput: (needle: string, timeoutMs?: number) => Promise<void>;
}

function startFixture(mode: string, budgets: { warning: number; force: number }): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), `game-cat-lifecycle-${mode}-`));
  const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, dataDir, mode], {
    cwd: ROOT,
    env: {
      ...process.env,
      LIFECYCLE_WARN_MS: String(budgets.warning),
      LIFECYCLE_FORCE_MS: String(budgets.force),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<number | null>((resolveExit) => {
    child.on("exit", (code) => resolveExit(code));
  });

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    dataDir,
    exit,
    async waitForOutput(needle: string, timeoutMs = 20_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (`${stdout}${stderr}`.includes(needle)) {
          return;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      throw new Error(`fixture did not print ${needle}:\n${stdout}${stderr}`);
    },
  };
}

async function waitForExit(fixture: Fixture, timeoutMs: number): Promise<number | null> {
  return await Promise.race([
    fixture.exit,
    new Promise<number | null>((_, reject) =>
      setTimeout(() => reject(new Error(`fixture did not exit within ${timeoutMs} ms`)), timeoutMs),
    ),
  ]);
}

function logLines(dataDir: string): Array<Record<string, unknown>> {
  const path = join(dataDir, "logs", "game-cat.log");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function activeRun(dataDir: string): { status: string; error_code: string | null } {
  const db = new BetterSqlite3(join(dataDir, "game-cat.sqlite"), { readonly: true });
  try {
    return db
      .prepare("SELECT status, error_code FROM refresh_runs ORDER BY id DESC LIMIT 1")
      .get() as { status: string; error_code: string | null };
  } finally {
    db.close();
  }
}

describe("process lifecycle", () => {
  it("AC-P4 SIGTERM aborts upstream work, marks the run INTERRUPTED, and exits 0", async () => {
    const fixture = startFixture("abortable", { warning: 5_000, force: 10_000 });
    await fixture.waitForOutput("SOURCE_STARTED");

    const startedAt = Date.now();
    fixture.child.kill("SIGTERM");
    const code = await waitForExit(fixture, 5_000);
    const elapsed = Date.now() - startedAt;

    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(5_000);
    expect(activeRun(fixture.dataDir)).toEqual({
      status: "failed",
      error_code: "INTERRUPTED",
    });
    expect(existsSync(join(fixture.dataDir, "game-cat.lock"))).toBe(false);

    const messages = logLines(fixture.dataDir).map((line) => line.msg);
    expect(messages).toContain("shutting down");
    expect(messages).toContain("shutdown complete");
  });

  it("AC-P4 warns at the budget and exits non-zero when cleanup never finishes", async () => {
    const fixture = startFixture("hang", { warning: 100, force: 500 });
    await fixture.waitForOutput("SOURCE_STARTED");

    fixture.child.kill("SIGTERM");
    const code = await waitForExit(fixture, 5_000);

    expect(code).not.toBe(0);
    expect(fixture.stderr()).toContain("shutdown is taking longer than expected");
    expect(fixture.stderr()).toContain("shutdown exceeded the graceful budget");
    expect(logLines(fixture.dataDir).map((line) => line.msg)).toContain(
      "shutdown exceeded the graceful budget; exiting non-zero",
    );
  });

  it("AC-P4 a second signal exits immediately", async () => {
    const fixture = startFixture("hang", { warning: 5_000, force: 9_000 });
    await fixture.waitForOutput("SOURCE_STARTED");

    fixture.child.kill("SIGTERM");
    await fixture.waitForOutput("shutting down");
    const startedAt = Date.now();
    fixture.child.kill("SIGTERM");
    const code = await waitForExit(fixture, 2_000);

    expect(code).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(fixture.stderr()).toContain("second shutdown signal; exiting now");
  });
});
