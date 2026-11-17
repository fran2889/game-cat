// Production build: Vite emits dist/client; tsc emits dist/server and
// dist/shared with .ts import specifiers rewritten to .js.
import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteCli = join(root, "node_modules", "vite", "bin", "vite.js");
const tscCli = join(root, "node_modules", "typescript", "bin", "tsc");

function run(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    console.error(`[build] ${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(join(root, "dist"), { recursive: true, force: true });

run("theme css", [join(root, "scripts", "generate-theme-css.mjs")]);
run("vite build", [viteCli, "build"]);
run("tsc build", [tscCli, "-p", "tsconfig.server.json"]);

// Migrations are data, not compiled output. Ship them next to the server so
// `dist/server/db/migrations.js` resolves `dist/migrations`.
cpSync(join(root, "migrations"), join(root, "dist", "migrations"), { recursive: true });

console.log("[build] dist/client, dist/server, and dist/migrations are ready.");
