import { readFileSync } from "node:fs";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  configPatchBodySchema,
  gameContractDefinitions,
  gameDetailResponseSchema,
  gamesResponseSchema,
  libraryContractDefinitions,
  rejectNonCanonicalIntegers,
  ruleValuesResponseSchema,
  smartCollectionContractDefinitions,
  smartCollectionGamesResponseSchema,
  smartCollectionResponseSchema,
  smartCollectionsResponseSchema,
  steamCollectionGamesResponseSchema,
  steamCollectionResponseSchema,
  steamCollectionsResponseSchema,
  tagsResponseSchema,
} from "../../src/server/http/schemas.ts";
import { CONFIG_PATCH_FIELDS } from "../../src/shared/config.ts";

interface SchemaDocument {
  definitions: Record<string, unknown>;
  [name: string]: unknown;
}

const contract = JSON.parse(
  readFileSync(new URL("../contract/schemas.json", import.meta.url), "utf8"),
) as SchemaDocument;

const GAME_DEFINITIONS = [
  "pagination",
  "timestamp",
  "nullableTimestamp",
  "gameTag",
  "gamePlatforms",
  "gameMetadata",
  "gameSummary",
  "gameDetail",
] as const;

const LIBRARY_DEFINITIONS = ["tagSummary", "ruleValue", "steamCollectionSummary"] as const;

const SMART_DEFINITIONS = ["rule", "smartCollection", "smartCollectionListItem"] as const;

function root(schema: Record<string, unknown>): Record<string, unknown> {
  const { definitions: _definitions, ...rest } = schema;
  return rest;
}

/**
 * The contract writes the Rule value as a multi-type `type` array. The runtime
 * schema uses `anyOf` because fast-json-stringify would otherwise serialize an
 * integer array as a comma-separated string. Normalize the contract form so the
 * two can still be compared field for field.
 */
function normalizeRuleDefinition(definition: unknown): unknown {
  const copy = structuredClone(definition) as {
    properties: { value: Record<string, unknown> };
  };
  const value = copy.properties.value;
  const types = value.type;
  if (Array.isArray(types)) {
    copy.properties.value = {
      anyOf: types.map((type) =>
        type === "array" ? { type: "array", items: value.items } : { type },
      ),
    };
  }
  return copy;
}

describe("Games response schemas", () => {
  it("match the contract definitions for every Game shape", () => {
    for (const name of GAME_DEFINITIONS) {
      expect(gameContractDefinitions, name).toHaveProperty(name);
      expect(gameContractDefinitions[name], name).toEqual(contract.definitions[name]);
    }
  });

  it("match the contract list and detail envelopes", () => {
    expect(root(gamesResponseSchema)).toEqual(contract.gamesResponse);
    expect(root(gameDetailResponseSchema)).toEqual(contract.gameDetailResponse);
  });
});

describe("Library and Smart Collection response schemas", () => {
  it("match every implemented contract definition", () => {
    const definitions = {
      ...libraryContractDefinitions,
      ...smartCollectionContractDefinitions,
    };
    const names = [...GAME_DEFINITIONS, ...LIBRARY_DEFINITIONS, ...SMART_DEFINITIONS];
    expect(Object.keys(definitions).sort()).toEqual([...names].sort());

    for (const name of names) {
      if (name === "rule") {
        continue;
      }
      expect(definitions[name], name).toEqual(contract.definitions[name]);
    }
  });

  it("match the Rule definition up to the serializer's anyOf form", () => {
    expect(normalizeRuleDefinition(smartCollectionContractDefinitions.rule)).toEqual(
      normalizeRuleDefinition(contract.definitions.rule),
    );
  });

  it("match every implemented response envelope", () => {
    const envelopes = {
      tagsResponse: tagsResponseSchema,
      ruleValuesResponse: ruleValuesResponseSchema,
      steamCollectionsResponse: steamCollectionsResponseSchema,
      steamCollectionResponse: steamCollectionResponseSchema,
      steamCollectionGamesResponse: steamCollectionGamesResponseSchema,
      smartCollectionsResponse: smartCollectionsResponseSchema,
      smartCollectionResponse: smartCollectionResponseSchema,
      smartCollectionGamesResponse: smartCollectionGamesResponseSchema,
    };
    for (const [name, schema] of Object.entries(envelopes)) {
      expect(root(schema), name).toEqual(contract[name]);
    }
  });
});

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
