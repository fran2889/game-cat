import { describe, expect, it } from "vitest";
import { StartupError } from "../../src/server/errors.ts";
import { assertNodeVersion } from "../../src/server/node-version.ts";

describe("Node runtime floor", () => {
  it("AC-C1 refuses Node 22 with NODE_VERSION", () => {
    expect(() => assertNodeVersion("22.11.0")).toThrowError(StartupError);
    try {
      assertNodeVersion("22.11.0");
    } catch (error) {
      expect(error).toBeInstanceOf(StartupError);
      expect((error as StartupError).code).toBe("NODE_VERSION");
      expect((error as StartupError).message).toContain("22.11.0");
      expect((error as StartupError).message).toContain("24");
    }
  });

  it("accepts the supported Node 24 and Node 26 majors", () => {
    expect(() => assertNodeVersion("24.0.0")).not.toThrow();
    expect(() => assertNodeVersion("26.13.1")).not.toThrow();
  });

  it("rejects a malformed version string", () => {
    expect(() => assertNodeVersion("not-a-version")).toThrowError(StartupError);
  });
});
