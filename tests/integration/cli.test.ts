import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "src", "server", "cli.ts");

const children: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  while (children.length > 0) {
    const child = children.pop();
    if (child !== null && child !== undefined && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
});

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GAME_CAT_")) {
      delete env[key];
    }
  }
  return env;
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      env: cleanEnv(),
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

describe("CLI", () => {
  it("--version prints the app version and the schema version", async () => {
    const result = await runCli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("0.1.0");
    expect(result.stdout).toContain("schema 1");
  });

  it("--help lists the flags", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--data-dir");
    expect(result.stdout).toContain("--no-open");
  });

  it("exits 2 for a usage error", async () => {
    const result = await runCli(["--nope"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown option");
  });

  it("exits CONFIG_INVALID before listening", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "game-cat-cli-config-"));
    writeFileSync(join(dataDir, "config.json"), "{", { mode: 0o600 });
    const result = await runCli(["--data-dir", dataDir, "--port", "0", "--no-open"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CONFIG_INVALID");
    expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
  });

  it("starts, prints the loopback URL, and shuts down cleanly on SIGTERM", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "game-cat-cli-"));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        CLI,
        "--data-dir",
        dataDir,
        "--port",
        "0",
        "--no-open",
        "--log-level",
        "error",
      ],
      { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);

    let stdout = "";
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const url = await new Promise<string>((resolveUrl, rejectUrl) => {
      const timer = setTimeout(() => {
        rejectUrl(new Error(`CLI did not print a URL. stderr: ${stderr}`));
      }, 20_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
        if (match !== null) {
          clearTimeout(timer);
          resolveUrl(match[0]);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        rejectUrl(new Error(`CLI exited early with ${code}. stderr: ${stderr}`));
      });
    });

    const response = await fetch(`${url}api/status`);
    expect(response.status).toBe(200);
    expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(true);

    const exited = new Promise<number | null>((resolveExit) => {
      child.on("exit", (code) => resolveExit(code));
    });
    child.kill("SIGTERM");
    const code = await exited;
    expect(code).toBe(0);
    expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
  });

  it.each(["SIGINT", "SIGHUP"] as const)(
    "AC-P4 %s also exits 0 and releases the lock",
    async (signal) => {
      const dataDir = mkdtempSync(join(tmpdir(), "game-cat-cli-signal-"));
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI,
          "--data-dir",
          dataDir,
          "--port",
          "0",
          "--no-open",
          "--log-level",
          "error",
        ],
        { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(child);

      let stdout = "";
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      await new Promise<void>((resolveUrl, rejectUrl) => {
        const timer = setTimeout(() => {
          rejectUrl(new Error(`CLI did not print a URL. stderr: ${stderr}`));
        }, 20_000);
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (/http:\/\/127\.0\.0\.1:\d+\//.test(stdout)) {
            clearTimeout(timer);
            resolveUrl();
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          rejectUrl(new Error(`CLI exited early with ${code}. stderr: ${stderr}`));
        });
      });

      const exited = new Promise<number | null>((resolveExit) => {
        child.on("exit", (code) => resolveExit(code));
      });
      child.kill(signal);
      const code = await exited;
      expect(code).toBe(0);
      expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
    },
  );
});
