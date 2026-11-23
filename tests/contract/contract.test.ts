import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import { httpSchemaDefinitions, responseSchemas } from "../../src/shared/http-schemas.ts";
import {
  CONTRACT_RESPONSE_NAMES,
  captureContractResponses,
  type CapturedResponses,
} from "../helpers/contract-harness.ts";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();

const definitionSchemas = httpSchemaDefinitions as Record<string, object>;
const envelopeSchemas = responseSchemas as Record<string, object>;

function compile(schema: object): ValidateFunction {
  return ajv.compile({ definitions: httpSchemaDefinitions, ...schema });
}

function validator(name: string): ValidateFunction {
  const cached = validators.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const root = envelopeSchemas[name] ?? definitionSchemas[name];
  if (root === undefined) {
    throw new Error(`No contract schema named ${name}`);
  }
  const compiled = compile(root);
  validators.set(name, compiled);
  return compiled;
}

function expectValid(name: string, value: unknown, label: string): void {
  const validate = validator(name);
  const valid = validate(value);
  expect(valid, `${label}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

interface Envelope {
  properties: Record<string, { $ref?: string; items?: { $ref?: string } }>;
}

/** The `data` (or `error`) definition an envelope is built around. */
function primaryDefinition(schema: object): string {
  const envelope = schema as Envelope;
  const payload = envelope.properties.data ?? envelope.properties.error;
  const ref = payload?.$ref ?? payload?.items?.$ref;
  if (ref === undefined) {
    throw new Error("Envelope has no data or error definition");
  }
  return ref.replace("#/definitions/", "");
}

/**
 * Definitions a response always evaluates. A list can legitimately be empty,
 * so its required pagination is corrupted alongside the item definition.
 */
function alwaysEvaluated(schema: object): string[] {
  const names = [primaryDefinition(schema)];
  const pagination = (schema as Envelope).properties.pagination;
  const ref = pagination?.$ref;
  if (ref !== undefined) {
    names.push(ref.replace("#/definitions/", ""));
  }
  return names;
}

const spec = readFileSync(new URL("../../docs/specs/game-cat-v1.md", import.meta.url), "utf8");

/** The Nth fenced JSON block after an exact Markdown heading. */
function specExample(heading: string, occurrence = 0): unknown {
  const lines = spec.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    throw new Error(`Heading not found: ${heading}`);
  }
  let seen = 0;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (!lines[index]!.trim().startsWith("```json")) {
      continue;
    }
    if (seen !== occurrence) {
      seen += 1;
      index = skipFence(lines, index);
      continue;
    }
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor]!.trim() === "```") {
        return JSON.parse(body.join("\n"));
      }
      body.push(lines[cursor]!);
    }
    throw new Error(`Unclosed JSON block after ${heading}`);
  }
  throw new Error(`No JSON example after ${heading}`);
}

function skipFence(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === "```") {
      return index;
    }
  }
  return lines.length;
}

describe("documented JSON examples", () => {
  it("validates the §4.2 common objects", () => {
    expectValid("gameSummary", specExample("#### `GameSummary`"), "GameSummary");
    expectValid("gameDetail", specExample("#### `GameDetail`"), "GameDetail");
    expectValid("rule", specExample("#### `Rule`"), "Rule");
    expectValid("smartCollection", specExample("#### `SmartCollection`", 0), "SmartCollection");
    expectValid(
      "smartCollectionListItem",
      specExample("#### `SmartCollection`", 1),
      "SmartCollectionListItem",
    );
    expectValid(
      "steamCollectionSummary",
      specExample("#### `SteamCollectionSummary`"),
      "SteamCollectionSummary",
    );
    expectValid("errorDetail", specExample("#### `ErrorDetail`"), "ErrorDetail");
    expectValid("refreshRun", specExample("#### `RefreshRun`"), "RefreshRun");
    expectValid("status", specExample("#### `Status`"), "Status");
    expectValid("sourceHealth", specExample("#### `SourceHealth`"), "SourceHealth");
    expectValid("config", specExample("#### `Config`"), "Config");
    expectValid("steamAccount", specExample("#### `SteamAccount`"), "SteamAccount");
  });

  it("validates the paginated §4.3 list examples", () => {
    expectValid("tagsResponse", specExample("#### `GET /api/tags`"), "tags");
    expectValid("ruleValuesResponse", specExample("#### `GET /api/rule-values`"), "rule values");
  });

  it("validates the non-deduplicated and deduplicated Refresh start envelopes", () => {
    const run = specExample("#### `RefreshRun`");
    expectValid("refreshStartResponse", { data: run }, "start");
    expectValid(
      "refreshStartResponse",
      { data: run, meta: { deduplicated: true } },
      "deduplicated start",
    );
    expect(validator("refreshStartResponse")({ data: run, meta: { deduplicated: false } })).toBe(
      false,
    );
  });

  it("enforces required, enum, nullable, and camelCase fields", () => {
    const game = specExample("#### `GameSummary`") as Record<string, unknown>;
    expectValid("gameSummary", game, "example");

    const missingName = { ...game };
    delete missingName.name;
    expect(validator("gameSummary")(missingName)).toBe(false);

    expect(validator("gameSummary")({ ...game, ownershipStatus: "owned " })).toBe(false);
    expect(validator("gameSummary")({ ...game, installed: "true" })).toBe(false);
    expect(validator("gameSummary")({ ...game, tags: null })).toBe(false);
    expect(validator("gameSummary")({ ...game, app_id: 620 })).toBe(false);
    expect(validator("gameSummary")({ ...game, reviewScore: null })).toBe(true);
  });
});

/**
 * The golden fixtures are the independent oracle: they are captured response
 * data, not a second schema. A drifted schema fails either this comparison
 * (because Fastify no longer serialises the captured shape) or the validation
 * below (because the schema rejects its own fixture).
 */
const golden = JSON.parse(
  readFileSync(new URL("./golden.json", import.meta.url), "utf8"),
) as CapturedResponses;

describe("captured golden responses", () => {
  it("match the current API for every response and status code", async () => {
    const captured = await captureContractResponses();
    expect(Object.keys(captured).sort()).toEqual(Object.keys(golden).sort());
    for (const name of CONTRACT_RESPONSE_NAMES) {
      expect(captured[name], name).toEqual(golden[name]);
    }
  });

  it("validate every golden body against the shared response schema", () => {
    for (const [name, response] of Object.entries(golden)) {
      if (response.body === undefined) {
        continue;
      }
      expectValid(response.schema!, response.body, name);
    }
  });

  /**
   * Corrupt the shared definition behind each envelope, not the envelope's
   * top-level property, so this exercises the nested shapes that Fastify and
   * the contract suite actually share.
   */
  it("rejects fixtures when a shared definition drifts", () => {
    for (const [name, response] of Object.entries(golden)) {
      if (response.body === undefined) {
        continue;
      }
      const schema = envelopeSchemas[response.schema!]!;
      const corrupted = Object.fromEntries(
        alwaysEvaluated(schema).map((definition) => [definition, { not: {} }]),
      );
      const validate = ajv.compile({
        ...schema,
        definitions: { ...httpSchemaDefinitions, ...corrupted },
      });
      expect(validate(response.body), `${name}: ${Object.keys(corrupted).join(", ")}`).toBe(false);
    }
  });
});
