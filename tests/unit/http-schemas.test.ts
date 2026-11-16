import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  gameContractDefinitions,
  gameDetailResponseSchema,
  gamesResponseSchema,
} from "../../src/server/http/schemas.ts";

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

function root(schema: Record<string, unknown>): Record<string, unknown> {
  const { definitions: _definitions, ...rest } = schema;
  return rest;
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
