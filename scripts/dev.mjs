// Development runner: the API (tsx + the real CLI) and Vite together.
//
// The browser always talks to Vite on 5173. Vite proxies /api to the API on
// GAME_CAT_PORT (default 4780), so the production Host/Origin checks run
// unchanged. Stop either child and the other is stopped too.
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const viteCli = join(root, "node_modules", "vite", "bin", "vite.js");

const children = [];
let stopping = false;

function run(label, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  children.push({ label, child });

  child.on("error", (error) => {
    console.error(`[dev] ${label} failed to start: ${error.message}`);
    void shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) {
      return;
    }
    console.error(
      `[dev] ${label} exited (${signal ?? `code ${code ?? "unknown"}`}); stopping the other process.`,
    );
    void shutdown(code ?? 1);
  });

  return child;
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
}

async function shutdown(code) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  await Promise.all(children.map(({ child }) => waitForExit(child)));
  process.exit(code);
}

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});

// The client imports the generated stylesheet, so write it once before Vite
// starts. Restart dev after editing theme.ts.
const theme = spawnSync(process.execPath, [join(root, "scripts", "generate-theme-css.mjs")], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
if (theme.status !== 0) {
  console.error(
    theme.error === undefined
      ? "[dev] theme css generation failed."
      : `[dev] theme css generation failed: ${theme.error.message}`,
  );
  process.exit(theme.status ?? 1);
}

console.log("[dev] API:   http://127.0.0.1:4780/ (or GAME_CAT_PORT)");
console.log("[dev] UI:    http://127.0.0.1:5173/");
console.log("[dev] Press Ctrl+C to stop both.");

run("api", [tsxCli, "src/server/cli.ts", "--no-open"]);
run("vite", [viteCli]);
