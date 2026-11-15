// Packaging smoke test for the supported install path (§8.2, AC-Q6).
//
// 1. `npm pack` runs the `prepare` build and produces the tarball.
// 2. A global install into a throwaway prefix installs the `game-cat` binary.
// 3. The installed CLI prints the documented flags and versions.
// 4. The installed CLI starts the production build and serves GET /api/status.
//
// This is deliberately not part of `npm test`: it installs dependencies into a
// temporary prefix and is run by the CI package job and before a release.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const work = mkdtempSync(join(tmpdir(), "game-cat-package-"));
const packDir = join(work, "pack");
const prefix = join(work, "prefix");
const dataDir = join(work, "data");

function fail(message) {
  console.error(`[package] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error !== undefined) {
    fail(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} exited ${result.status}\n` +
        `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function parsePackOutput(stdout) {
  // `prepare` writes build output to stdout before npm's JSON result.
  const lines = stdout.split("\n");
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === "[") {
      start = index;
      break;
    }
  }
  if (start < 0) {
    fail(`npm pack did not print JSON:\n${stdout}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(lines.slice(start).join("\n"));
  } catch {
    fail(`npm pack did not print JSON:\n${stdout}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0]?.filename !== "string") {
    fail(`npm pack returned an unexpected result:\n${stdout}`);
  }
  return parsed[0].filename;
}

function binaryPath() {
  return process.platform === "win32"
    ? join(prefix, "game-cat.cmd")
    : join(prefix, "bin", "game-cat");
}

try {
  mkdirSync(packDir, { recursive: true });
  const pack = run("npm", ["pack", "--json", "--pack-destination", packDir]);
  const filename = parsePackOutput(pack.stdout);
  const tarball = join(packDir, filename);
  if (!existsSync(tarball)) {
    fail(`tarball was not created at ${tarball}`);
  }

  run(npm, ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball]);
  const binary = binaryPath();
  if (!existsSync(binary)) {
    fail(`the tarball did not install the game-cat binary at ${binary}`);
  }

  const help = run(binary, ["--help"]).stdout;
  for (const flag of ["--data-dir", "--port", "--no-open", "--log-level", "--help", "--version"]) {
    if (!help.includes(flag)) {
      fail(`--help does not document ${flag}:\n${help}`);
    }
  }

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = run(binary, ["--version"]).stdout;
  if (!version.includes(pkg.version) || !version.includes("schema")) {
    fail(`--version did not print the app and schema version:\n${version}`);
  }

  const child = spawn(
    binary,
    ["--data-dir", dataDir, "--port", "0", "--no-open", "--log-level", "error"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(
      () => rejectUrl(new Error(`installed CLI did not print a URL:\n${stdout}${stderr}`)),
      20_000,
    );
    child.stdout.on("data", () => {
      const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`installed CLI exited early with ${code}:\n${stdout}${stderr}`));
    });
  });

  const response = await fetch(`${url}api/status`);
  if (response.status !== 200) {
    fail(`installed CLI served /api/status with ${response.status}`);
  }

  const exited = new Promise((resolveExit) => child.on("exit", resolveExit));
  child.kill("SIGTERM");
  const code = await exited;
  if (code !== 0) {
    fail(`installed CLI exited with ${code} on SIGTERM`);
  }

  console.log(`[package] ok: ${tarball}`);
  console.log(`[package] installed binary: ${binary}`);
  console.log(`[package] --help, --version, GET /api/status, and SIGTERM passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
