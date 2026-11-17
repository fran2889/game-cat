import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RULE_FIELD_DEFINITIONS,
  RULE_FIELDS,
  RULE_OPERATORS,
  RULE_PREFIXES,
  type Rule,
  type RuleFieldDefinition,
  type RuleValue,
} from "../../src/shared/rules.ts";
import {
  allowedOperators,
  changeRuleField,
  validateCollectionName,
  validateDraftRules,
} from "../../src/client/rule-editor.ts";
import { openAppDatabase, type AppDatabase } from "../../src/server/db/database.ts";
import { createHttpApp } from "../../src/server/http/app.ts";
import { smartCollectionContractDefinitions } from "../../src/server/http/schemas.ts";
import { SteamCollectionsRepository } from "../../src/server/library/collections.ts";
import { GamesRepository } from "../../src/server/library/games.ts";
import { RulePreviewRepository } from "../../src/server/library/rule-preview.ts";
import { RuleValuesRepository } from "../../src/server/library/rule-values.ts";
import {
  SmartCollectionsRepository,
  validateSmartCollectionName,
} from "../../src/server/library/smart-collections.ts";
import { TagsRepository } from "../../src/server/library/tags.ts";
import { RefreshService } from "../../src/server/refresh/service.ts";
import type { Status } from "../../src/shared/types.ts";

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;

let dataDir: string;
let db: AppDatabase;
let app: ReturnType<typeof createHttpApp>;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "game-cat-rule-drift-"));
  db = openAppDatabase({ dataDir, steamWebApiConfigured: false });
  app = createHttpApp({
    port: PORT,
    clientDir: null,
    logger: pino({ level: "silent" }),
    status: () => ({}) as Status,
    library: {
      games: new GamesRepository(db.raw),
      collections: new SteamCollectionsRepository(db.raw),
      ruleValues: new RuleValuesRepository(db.raw),
      tags: new TagsRepository(db.raw),
      rulePreview: new RulePreviewRepository(db.raw),
      smartCollections: new SmartCollectionsRepository(db.raw),
      refresh: new RefreshService({
        db: db.raw,
        steamRoot: null,
        steamId64: null,
        now: () => 1_700_000_000,
      }),
    },
  });
});

afterAll(async () => {
  await app?.close();
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function ruleFor(field: RuleFieldDefinition, operator: string, value: unknown): Rule {
  return {
    prefix: "AND",
    field: field.field,
    operator: operator as Rule["operator"],
    value: value as RuleValue,
  };
}

/** A value the Field accepts, used to isolate the Field/Operator table. */
function sampleValue(definition: RuleFieldDefinition): RuleValue {
  switch (definition.valueKind) {
    case "boolean":
      return true;
    case "integer": {
      const min = definition.min ?? 0;
      const max = definition.max ?? 1_000;
      return Math.min(max, Math.max(min, 50));
    }
    case "enum":
      return definition.values?.[0] ?? "";
    case "date":
      return "2024-01-01";
    case "appIds":
      return [10];
    case "steamCollection":
      return "uc-sample";
    case "text":
    case "openEnum":
    case "multiText":
      return "Sample";
  }
}

async function serverRejects(rule: unknown): Promise<boolean> {
  const response = await app.inject({
    method: "POST",
    url: "/api/rules/preview",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { rules: [rule] },
  });
  expect([200, 422], JSON.stringify(rule)).toContain(response.statusCode);
  return response.statusCode === 422;
}

function clientRejects(rule: unknown): boolean {
  return Object.keys(validateDraftRules([rule]).fieldErrors).length > 0;
}

describe("the editor and the API agree about Rule validity", () => {
  it("uses the shared Field, Operator, and Prefix lists in the server route schema", () => {
    const schema = smartCollectionContractDefinitions.rule as {
      properties: {
        prefix: { enum: string[] };
        field: { enum: string[] };
        operator: { enum: string[] };
      };
    };
    expect(schema.properties.prefix.enum).toEqual([...RULE_PREFIXES]);
    expect(schema.properties.field.enum).toEqual([...RULE_FIELDS]);
    expect(schema.properties.operator.enum).toEqual([...RULE_OPERATORS]);
  });

  it("exposes the shared Operator set and defaults through the client helpers", () => {
    for (const definition of RULE_FIELD_DEFINITIONS) {
      expect(allowedOperators(definition.field), definition.field).toEqual(definition.operators);
      const changed = changeRuleField(
        { prefix: "AND", field: "name", operator: "contains", value: "x" },
        definition.field,
      );
      expect(definition.operators, definition.field).toContain(changed.operator);
    }
  });

  it("accepts exactly the Field/Operator pairs the API accepts", async () => {
    const mismatches: string[] = [];
    for (const definition of RULE_FIELD_DEFINITIONS) {
      const value = sampleValue(definition);
      for (const operator of RULE_OPERATORS) {
        const rule = ruleFor(definition, operator, value);
        const client = clientRejects(rule);
        const server = await serverRejects(rule);
        if (client !== server) {
          mismatches.push(
            `${definition.field} ${operator}: client ${client ? "rejects" : "accepts"}, server ${
              server ? "rejects" : "accepts"
            }`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("accepts exactly the Values the API accepts", async () => {
    const cases: Array<{ rule: Record<string, unknown>; valid: boolean }> = [
      { rule: { field: "playtime", operator: "lt", value: 600 }, valid: true },
      { rule: { field: "playtime", operator: "lt", value: "600" }, valid: false },
      { rule: { field: "installed", operator: "is", value: true }, valid: true },
      { rule: { field: "installed", operator: "is", value: "true" }, valid: false },
      { rule: { field: "tag", operator: "has", value: ["Co-op"] }, valid: false },
      { rule: { field: "tag", operator: "has", value: "" }, valid: false },
      { rule: { field: "tag", operator: "has", value: "a".repeat(201) }, valid: false },
      { rule: { field: "tag", operator: "has", value: "bad\u0000value" }, valid: false },
      { rule: { field: "name", operator: "is", value: "   " }, valid: false },
      { rule: { field: "lastPlayed", operator: "gte", value: "2024-02-30" }, valid: false },
      {
        rule: { field: "ownershipStatus", operator: "is", value: "owned_elsewhere" },
        valid: false,
      },
      { rule: { field: "platform", operator: "has", value: "android" }, valid: false },
      { rule: { field: "releaseYear", operator: "lt", value: 999 }, valid: false },
      { rule: { field: "releaseYear", operator: "lt", value: 10_000 }, valid: false },
      { rule: { field: "metacriticScore", operator: "gt", value: 101 }, valid: false },
      { rule: { field: "game", operator: "in", value: 620 }, valid: false },
      { rule: { field: "game", operator: "in", value: [10, 10] }, valid: false },
      { rule: { field: "game", operator: "in", value: [] }, valid: false },
      { rule: { field: "game", operator: "in", value: [0] }, valid: false },
      { rule: { field: "game", operator: "in", value: [620, 4000] }, valid: true },
      { rule: { field: "steamCollection", operator: "has", value: "" }, valid: false },
      { rule: { field: "steamCollection", operator: "has", value: "uc-CoOp" }, valid: true },
    ];
    for (const { rule, valid } of cases) {
      const candidate = { prefix: "AND", ...rule };
      const client = clientRejects(candidate);
      const server = await serverRejects(candidate);
      expect(client, `client ${JSON.stringify(candidate)}`).toBe(!valid);
      expect(server, `server ${JSON.stringify(candidate)}`).toBe(!valid);
    }
  });

  it("agrees about Smart Collection names without sharing user-facing copy", () => {
    const names = [
      "",
      "   ",
      "Short co-op games",
      "  Padded name  ",
      "a".repeat(80),
      "a".repeat(81),
      "😀".repeat(80),
      "😀".repeat(81),
      "e\u0301".repeat(80),
      "e\u0301".repeat(81),
      "bad\u0000name",
    ];
    for (const name of names) {
      const fieldErrors: Record<string, string> = {};
      const accepted = validateSmartCollectionName(name, fieldErrors) !== null;
      expect(validateCollectionName(name) === null, JSON.stringify(name)).toBe(accepted);
    }
  });
});
