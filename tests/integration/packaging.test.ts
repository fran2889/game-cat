import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  scripts: Record<string, string>;
  exports?: Record<string, string>;
  main?: string;
};

describe("publish-ready package", () => {
  it("declares the bin, files whitelist, prepare build, and Node floor", () => {
    expect(PACKAGE.bin["game-cat"]).toBe("dist/server/cli.js");
    expect(PACKAGE.files).toContain("dist");
    expect(PACKAGE.files).toContain("migrations");
    expect(PACKAGE.engines.node).toBe(">=24");
    expect(PACKAGE.scripts.prepare).toBe("npm run build");
    expect(PACKAGE.main).toBe("./dist/server/index.js");
    expect(PACKAGE.exports?.["."]).toBe("./dist/server/index.js");
  });

  it("includes migrations in the packed file list", () => {
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status).toBe(0);
    const packed = JSON.parse(result.stdout.trim()) as Array<{
      files: Array<{ path: string }>;
    }>;
    const paths = packed[0]?.files.map((file) => file.path) ?? [];
    expect(paths).toContain("migrations/0001_initial.sql");
    expect(paths).toContain("README.md");
    expect(paths).toContain("LICENSE");
  });
});
