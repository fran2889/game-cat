import { describe, expect, it } from "vitest";
import {
  getVdfNumber,
  getVdfObject,
  getVdfString,
  parseVdf,
  VdfParseError,
} from "../../src/server/steam/vdf.ts";

describe("VDF reader", () => {
  it("parses quoted and unquoted tokens, nested objects, and numeric strings", () => {
    const document = parseVdf(`
      "AppState"
      {
        appid 620
        "name" "Portal 2"
        "InstalledDepots" { "621" { "manifest" "1" "size" "8" } }
      }
    `);

    const state = getVdfObject(document, "appstate")!;
    expect(getVdfString(state, "appid")).toBe("620");
    expect(getVdfString(state, "name")).toBe("Portal 2");
    expect(getVdfObject(state, "installeddepots")).toEqual({
      "621": { manifest: "1", size: "8" },
    });
    // Numeric-looking values stay strings; callers convert explicitly.
    expect(typeof getVdfString(state, "appid")).toBe("string");
  });

  it("looks every key up case-insensitively", () => {
    const document = parseVdf(`"root" { "StateFlags" "4" "Playtime2Wks" "45" }`);
    const root = getVdfObject(document, "ROOT");
    expect(root).toBeDefined();
    expect(getVdfString(root!, "stateflags")).toBe("4");
    expect(getVdfString(root!, "playtime2wks")).toBe("45");
  });

  it("keeps the last duplicate assignment even when casing differs", () => {
    const document = parseVdf(`"root" { "apps" { "1" "a" } "Apps" { "2" "b" } }`);
    const root = getVdfObject(document, "root")!;
    const apps = getVdfObject(root, "apps")!;
    expect(apps).toEqual({ "2": "b" });
    expect(Object.keys(root)).toEqual(["Apps"]);
  });

  it("handles the documented escapes and keeps an unknown escape literal", () => {
    const document = parseVdf(`"root" { "path" "M:\\\\Steam" "quote" "a\\"b" "tab" "a\\tb" }`);
    const root = getVdfObject(document, "root")!;
    expect(getVdfString(root, "path")).toBe("M:\\Steam");
    expect(getVdfString(root, "quote")).toBe('a"b');
    expect(getVdfString(root, "tab")).toBe("a\tb");
  });

  it("tolerates a UTF-8 BOM and Windows-1252 replacement bytes", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('"root" { "name" "Caf', "latin1"),
      Buffer.from([0xe9]),
      Buffer.from('" }', "latin1"),
    ]);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const root = getVdfObject(parseVdf(text), "root")!;
    expect(getVdfString(root, "name")).toBe("Caf\uFFFD");
  });

  it("rejects an unclosed object at EOF", () => {
    expect(() => parseVdf(`"root" { "value" "1"`)).toThrow(VdfParseError);
  });

  it("rejects an unexpected closing brace", () => {
    expect(() => parseVdf(`"root" { } }`)).toThrow(VdfParseError);
  });

  it("converts numeric values defensively", () => {
    const root = getVdfObject(parseVdf(`"root" { "a" "12" "b" "x" "c" "-3" }`), "root")!;
    expect(getVdfNumber(root, "a")).toBe(12);
    expect(getVdfNumber(root, "b")).toBeNull();
    expect(getVdfNumber(root, "c")).toBe(-3);
  });

  it("ignores // comments and # macros without following includes", () => {
    const document = parseVdf(`
      // leading comment
      "root"
      {
        #include "other.vdf"
        "value" "1" // trailing
      }
    `);
    expect(getVdfString(getVdfObject(document, "root")!, "value")).toBe("1");
  });
});
