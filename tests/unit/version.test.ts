import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_NAME, APP_VERSION, DB_SCHEMA_VERSION, MIN_NODE_MAJOR } from "../../src/shared/app.ts";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

describe("application identity", () => {
  it("reads APP_VERSION from package.json so the version has one source of truth", () => {
    expect(APP_VERSION).toBe(packageJson.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
    expect(packageJson.name).toBe(APP_NAME);
  });

  it("keeps the database schema version independent of the package version", () => {
    expect(DB_SCHEMA_VERSION).toBe(1);
    expect(MIN_NODE_MAJOR).toBeGreaterThanOrEqual(24);
  });
});
