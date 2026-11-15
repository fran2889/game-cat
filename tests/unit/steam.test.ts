import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSteam } from "../../src/server/steam/discovery.ts";
import { parseVdf, VdfParseError } from "../../src/server/steam/vdf.ts";

const singleAccount = `"users"
{
\t"76561198000000000"
\t{
\t\t"AccountName"\t\t"tester_login"
\t\t"PersonaName"\t\t"Fran"
\t\t"RememberPassword"\t\t"1"
\t\t"Timestamp"\t\t"1700000000"
\t\t"MostRecent"\t\t"1"
\t}
}
`;

function steamRoot(loginusers?: string): string {
  const root = mkdtempSync(join(tmpdir(), "game-cat-steam-"));
  if (loginusers !== undefined) {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "loginusers.vdf"), loginusers);
  }
  return root;
}

describe("VDF parser", () => {
  it("parses quoted nested objects, comments, and escapes", () => {
    const parsed = parseVdf(`// leading comment
      "users" {
        "1" { "PersonaName" "A \\"quoted\\" name" } // trailing
        "2" { "Timestamp" "42" }
      }
    `);
    const users = parsed.users as Record<string, Record<string, string>>;
    expect(users["1"]?.PersonaName).toBe('A "quoted" name');
    expect(users["2"]?.Timestamp).toBe("42");
  });

  it("ignores platform conditionals", () => {
    const parsed = parseVdf(`"root" { "flag" "1" [$WIN32] }`);
    expect((parsed.root as Record<string, string>).flag).toBe("1");
  });

  it("throws a line-numbered error on malformed input", () => {
    expect(() => parseVdf(`"users" {\n  "pid"\n`)).toThrowError(VdfParseError);
  });
});

describe("Steam discovery", () => {
  it("AC-C14 reports not_found when Steam is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "game-cat-home-"));
    const result = discoverSteam({
      steamRoot: null,
      steamId64: null,
      platform: "linux",
      env: {},
      homedir: home,
    });
    expect(result.state).toBe("not_found");
    expect(result.root).toBeNull();
    expect(result.account).toBeNull();
  });

  it("selects the single account and derives its account ID", () => {
    const root = steamRoot(singleAccount);
    const result = discoverSteam({
      steamRoot: root,
      steamId64: null,
      platform: "linux",
      env: {},
      homedir: "/home/tester",
    });
    expect(result.state).toBe("ready");
    expect(result.account).toEqual({
      steamId64: "76561198000000000",
      accountId: "39734272",
      personaName: "Fran",
    });
  });

  it("AC-A21 never exposes AccountName through discovery", () => {
    const root = steamRoot(singleAccount);
    const result = discoverSteam({
      steamRoot: root,
      steamId64: null,
      platform: "linux",
      env: {},
      homedir: "/home/tester",
    });
    expect(JSON.stringify(result)).not.toContain("tester_login");
    expect(JSON.stringify(result)).not.toContain("AccountName");
  });

  it("uses the unique MostRecent account when several exist", () => {
    const root = steamRoot(`"users" {
      "76561198000000001" { "PersonaName" "One" "Timestamp" "900" }
      "76561198000000002" { "PersonaName" "Two" "Timestamp" "100" "MostRecent" "1" }
      "76561198000000003" { "PersonaName" "Three" "Timestamp" "500" }
    }`);
    const result = discoverSteam({
      steamRoot: root,
      steamId64: null,
      platform: "linux",
      env: {},
      homedir: "/home/tester",
    });
    expect(result.state).toBe("ready");
    expect(result.account?.steamId64).toBe("76561198000000002");
  });

  it("falls back to the newest Timestamp when MostRecent is ambiguous", () => {
    const root = steamRoot(`"users" {
      "76561198000000001" { "PersonaName" "One" "Timestamp" "900" "MostRecent" "1" }
      "76561198000000002" { "PersonaName" "Two" "Timestamp" "1000" "MostRecent" "1" }
    }`);
    const result = discoverSteam({
      steamRoot: root,
      steamId64: null,
      platform: "linux",
      env: {},
      homedir: "/home/tester",
    });
    expect(result.account?.steamId64).toBe("76561198000000002");
  });

  it("AC-C17 reports no_account when the pinned account is absent", () => {
    const root = steamRoot(singleAccount);
    const result = discoverSteam({
      steamRoot: root,
      steamId64: "76561198000000099",
      platform: "linux",
      env: {},
      homedir: "/home/tester",
    });
    expect(result.state).toBe("no_account");
    expect(result.account).toBeNull();
    expect(result.accounts).toHaveLength(1);
  });

  it("stays no_account when Steam has no logged-in account", () => {
    const root = steamRoot(`"users" { }`);
    const result = discoverSteam({
      steamRoot: root,
      steamId64: null,
      platform: "linux",
      env: {},
      homedir: "/home/tester",
    });
    expect(result.state).toBe("no_account");
  });

  it("reports a safe error for a malformed loginusers.vdf", () => {
    const root = steamRoot(`"users" { "76561198000000000" { "PersonaName" }`);
    const result = discoverSteam({
      steamRoot: root,
      steamId64: null,
      platform: "linux",
      env: {},
      homedir: "/home/tester",
    });
    expect(result.state).toBe("error");
    expect(result.error).not.toContain("tester_login");
  });

  it("discovers the default Linux Steam root when none is configured", () => {
    const home = mkdtempSync(join(tmpdir(), "game-cat-home-"));
    const defaultRoot = join(home, ".local", "share", "Steam");
    mkdirSync(join(defaultRoot, "config"), { recursive: true });
    writeFileSync(join(defaultRoot, "config", "loginusers.vdf"), singleAccount);

    const result = discoverSteam({
      steamRoot: null,
      steamId64: null,
      platform: "linux",
      env: {},
      homedir: home,
    });
    expect(result.root).toBe(defaultRoot);
    expect(result.state).toBe("ready");
  });

  it("does not silently fall back when a configured root is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "game-cat-home-"));
    const foundRoot = join(home, ".local", "share", "Steam");
    mkdirSync(join(foundRoot, "config"), { recursive: true });
    writeFileSync(join(foundRoot, "config", "loginusers.vdf"), singleAccount);

    const result = discoverSteam({
      steamRoot: join(home, "missing-Steam"),
      steamId64: null,
      platform: "linux",
      env: {},
      homedir: home,
    });
    expect(result.root).toBe(join(home, "missing-Steam"));
    expect(result.state).toBe("not_found");
    expect(result.account).toBeNull();
  });
});
