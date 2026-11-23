import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  configPatchBodySchema,
  rejectNonCanonicalIntegers,
} from "../../src/server/http/schemas.ts";
import { CONFIG_PATCH_FIELDS } from "../../src/shared/config.ts";

describe("Config patch schema", () => {
  it("accepts exactly the shared Config patch field set, all optional", () => {
    expect(Object.keys(configPatchBodySchema.properties)).toEqual([...CONFIG_PATCH_FIELDS]);
    expect(configPatchBodySchema).not.toHaveProperty("required");
  });
});

function requestWith(query: Record<string, unknown>): FastifyRequest {
  return { query } as FastifyRequest;
}

describe("Integer query values", () => {
  it("rejects values AJV would coerce from non-decimal strings", async () => {
    const guard = rejectNonCanonicalIntegers(200);
    for (const query of [
      { page: "1e3" },
      { page: "+1" },
      { page: "0x10" },
      { page: " 1" },
      { pageSize: "1e3" },
      { pageSize: "+20" },
    ]) {
      await expect(guard(requestWith(query)), JSON.stringify(query)).rejects.toMatchObject({
        statusCode: 422,
        code: "VALIDATION_ERROR",
      });
    }
  });

  it("leaves canonical, empty, absent, and repeated values to the schema", async () => {
    const guard = rejectNonCanonicalIntegers(200);
    for (const query of [{ page: "1" }, { page: "" }, { pageSize: "200" }, {}, { page: ["1"] }]) {
      await expect(guard(requestWith(query)), JSON.stringify(query)).resolves.toBeUndefined();
    }
  });

  it("names the field and its route-specific page-size bound", async () => {
    await expect(
      rejectNonCanonicalIntegers(100)(requestWith({ pageSize: "1e3" })),
    ).rejects.toMatchObject({
      details: {
        fieldErrors: { pageSize: "must be an integer between 1 and 100" },
      },
    });
  });
});
