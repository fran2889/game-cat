import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_VERSION } from "../../src/shared/app.ts";

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

interface StartedCli {
  child: ReturnType<typeof spawn>;
  stdout: () => string;
  stderr: () => string;
  url: Promise<string>;
  exit: Promise<number | null>;
}

/** Spawn the real CLI and resolve its readiness URL from stdout. */
function startCli(args: string[]): StartedCli {
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

  const url = new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      rejectUrl(new Error(`CLI did not print a URL. stderr: ${stderr}`));
    }, 20_000);
    child.stdout?.on("data", () => {
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

  const exit = new Promise<number | null>((resolveExit) => {
    child.on("exit", (code) => resolveExit(code));
  });

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    url,
    exit,
  };
}

describe("CLI", () => {
  it.each(["--version", "-v"])("%s prints the app version and the schema version", async (arg) => {
    const result = await runCli([arg]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(APP_VERSION);
    expect(result.stdout).toContain("schema 1");
  });

  it.each(["--help", "-h"])("%s lists the flags", async (arg) => {
    const result = await runCli([arg]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--data-dir");
    expect(result.stdout).toContain("--port");
    expect(result.stdout).toContain("--no-open");
    expect(result.stdout).toContain("--log-level");
    expect(result.stdout).toContain("--version");
  });

  it.each([
    [["--nope"], "Unknown option"],
    [["stray"], "Unexpected argument"],
    [["--port"], "requires a value"],
    [["--data-dir="], "requires a value"],
  ])("exits 2 for the usage error %j", async (args, message) => {
    const result = await runCli(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Usage: game-cat");
  });

  it("exits CONFIG_INVALID before listening", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "game-cat-cli-config-"));
    writeFileSync(join(dataDir, "config.json"), "{", { mode: 0o600 });
    const result = await runCli(["--data-dir", dataDir, "--port", "0", "--no-open"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CONFIG_INVALID");
    expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
  });

  it.each([
    [
      "space-separated",
      (dataDir: string) => [
        "--data-dir",
        dataDir,
        "--port",
        "0",
        "--no-open",
        "--log-level",
        "error",
      ],
    ],
    [
      "equals",
      (dataDir: string) => [
        `--data-dir=${dataDir}`,
        "--port=0",
        "--no-open",
        "--log-level=error",
      ],
    ],
  ])(
    "starts with %s values, prints the loopback URL, and shuts down cleanly on SIGTERM",
    async (_name, argsFor) => {
      const dataDir = mkdtempSync(join(tmpdir(), "game-cat-cli-"));
      const started = startCli(argsFor(dataDir));

      const url = await started.url;
      const response = await fetch(`${url}api/status`);
      expect(response.status).toBe(200);
      expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(true);

      started.child.kill("SIGTERM");
      const code = await started.exit;
      expect(code).toBe(0);
      expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
    },
  );

  it.each(["SIGINT", "SIGHUP"] as const)(
    "AC-P4 %s also exits 0 and releases the lock",
    async (signal) => {
      const dataDir = mkdtempSync(join(tmpdir(), "game-cat-cli-signal-"));
      const started = startCli([
        "--data-dir",
        dataDir,
        "--port",
        "0",
        "--no-open",
        "--log-level",
        "error",
      ]);

      await started.url;
      started.child.kill(signal);
      const code = await started.exit;
      expect(code).toBe(0);
      expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
    },
  );
});
