import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function lint(text: string, filePath: string) {
  const eslint = new ESLint({ cwd: ROOT });
  const results = await eslint.lintText(text, { filePath: `${ROOT}/${filePath}` });
  return results.flatMap((result) => result.messages.map((message) => ({ ...message, filePath })));
}

function build(...parts: string[]) {
  return parts.join("");
}

const HEX32 = "0123456789abcdef".repeat(2);

function accountLine(name: string) {
  return ['"AccountName"', `"${name}"`].join(" ");
}

function testCall(name: string, modifier?: string) {
  return build(
    "  ",
    name,
    modifier === undefined ? "" : `.${modifier}`,
    "(",
    '"works", () => {});',
  );
}

describe("lint gate", () => {
  it("rejects a focused test", async () => {
    const source = ["describe(", '"fixture", () => {', testCall("test", "only"), "});"].join("\n");

    const messages = await lint(source, "tests/unit/fixture.test.ts");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe("game-cat/no-focused-or-skipped-tests");
    expect(messages[0]?.message).toMatch(/focused test/i);
  });

  it.each(["fit", "fdescribe", "fcontext"])("rejects the focused alias %s", async (name) => {
    const messages = await lint(testCall(name), "tests/unit/fixture.test.ts");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatch(/focused test/i);
  });

  it.each(["skip", "fixme", "todo"])("rejects a test with the %s modifier", async (modifier) => {
    const messages = await lint(testCall("test", modifier), "tests/unit/fixture.test.ts");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatch(/skipped test/i);
  });

  it.each(["xit", "xdescribe", "xcontext"])("rejects the skipped alias %s", async (name) => {
    const messages = await lint(testCall(name), "tests/unit/fixture.test.ts");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatch(/skipped test/i);
  });

  it.each([
    ["allow-focus", "only"],
    ["allow-skip", "skip"],
  ])("honours an %s annotation on the preceding line", async (annotation, modifier) => {
    const source = [
      build("// audit-tests: ", annotation, " because the platform cannot run it"),
      testCall("test", modifier),
    ].join("\n");

    await expect(lint(source, "tests/unit/fixture.test.ts")).resolves.toEqual([]);
  });

  it("rejects a 32-hex key in Markdown", async () => {
    const messages = await lint(`Key: ${HEX32}`, "docs/fixture.md");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe("game-cat/no-secret-values");
    expect(messages[0]?.message).toMatch(/32 hexadecimal characters/);
  });

  it("rejects a 32-hex key in JSON", async () => {
    const messages = await lint(`{"key": "${HEX32}"}`, "docs/fixture.json");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatch(/32 hexadecimal characters/);
  });

  it("rejects an AccountName value", async () => {
    const messages = await lint(accountLine("real-person"), "src/fixture.ts");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe("game-cat/no-secret-values");
    expect(messages[0]?.message).toMatch(/AccountName/);
  });

  it("allows an AccountName from the synthetic list", async () => {
    await expect(lint(accountLine("account-under-test"), "src/fixture.ts")).resolves.toEqual([]);
  });

  it.each([
    ["/home/", "fran"],
    ["/Users/", "fran"],
  ])("rejects the raw home path %s%s/", async (prefix, name) => {
    const messages = await lint(`config: ${build(prefix, name, "/steam")}`, "docs/fixture.md");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatch(/raw Steam user path/i);
  });

  it.each(["tester", "user", "runner"])(
    "allows the documented home placeholder %s",
    async (name) => {
      await expect(
        lint(`config: ${build("/home/", name, "/steam")}`, "docs/fixture.md"),
      ).resolves.toEqual([]);
    },
  );

  it("rejects a Windows user path", async () => {
    const path = build("C:", "\\", "Users", "\\", "fran", "\\", "Steam");
    const messages = await lint(`config: ${path}`, "docs/fixture.md");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatch(/raw Steam user path/i);
  });

  it("passes clean text", async () => {
    await expect(lint("no keys or account values here\n", "docs/fixture.md")).resolves.toEqual([]);
  });

  it("covers every tracked file and finds no findings in the current tree", async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const results = await eslint.lintFiles(["."]);
    const linted = new Set(results.map((result) => result.filePath));
    const tracked = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((file) => `${ROOT}/${file}`);

    expect(tracked.length).toBeGreaterThan(0);
    expect(tracked.filter((file) => !linted.has(file))).toEqual([]);
    expect(
      results
        .filter((result) => result.errorCount > 0)
        .map((result) => `${result.filePath}: ${result.messages[0]?.message}`),
    ).toEqual([]);
  });
});
