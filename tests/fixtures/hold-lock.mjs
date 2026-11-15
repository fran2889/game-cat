// A real second process that holds a game-cat-style lock file so the parent
// test can prove ALREADY_RUNNING against a live PID.
import { writeFileSync } from "node:fs";

const lockPath = process.argv[2];
if (lockPath === undefined) {
  console.error("usage: hold-lock.mjs <lock-path>");
  process.exit(2);
}

const now = new Date();
writeFileSync(
  lockPath,
  `${JSON.stringify({
    pid: process.pid,
    startedAt: now.toISOString(),
    startTime: now.toISOString(),
    app: "game-cat",
    version: "test",
  })}\n`,
  { mode: 0o600 },
);
console.log("locked");
setInterval(() => {}, 1_000);
