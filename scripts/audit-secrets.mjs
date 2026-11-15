// Release guard for AC-Q5: no real Steam Web API key, `AccountName`, or raw
// Steam user path in a tracked or new (non-ignored) file.
//
// The patterns are deliberately narrow so the synthetic fixtures, docs, and
// tests do not false-positive:
//   - a Steam Web API key is exactly 32 hexadecimal characters;
//   - an `AccountName` value must be a known synthetic value;
//   - a `/home/<name>/`, `/Users/<name>/`, or `C:\Users\<name>\` segment must
//     be a documented placeholder.
// Add `audit-secrets: allow <reason>` to a line for a reviewed exception.
//
// Run by `npm run check`.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

const ALLOWED_ACCOUNT_NAMES = new Set([
  "account-under-test",
  "first",
  "second",
  "tester_login",
  "fixture-account",
  "test-account",
  "redacted",
  "<account>",
  "account",
]);

const ALLOWED_HOME_SEGMENTS = new Set([
  "tester",
  "user",
  "username",
  "you",
  "example",
  "runner",
  "me",
  "alice",
  "bob",
]);

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function listFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return output
      .split("\n")
      .filter(Boolean)
      .map((file) => join(ROOT, file))
      .filter((file) => statSync(file).isFile());
  } catch {
    return walk(ROOT);
  }
}

function isText(buffer) {
  return !buffer.includes(0);
}

const RULES = [
  {
    name: "possible Steam Web API key (32 hexadecimal characters)",
    pattern: /\b[0-9A-Fa-f]{32}\b/,
  },
  {
    name: "AccountName value",
    pattern: /["']AccountName["']\s+["']([^"']*)["']/,
    allowed: (match) => ALLOWED_ACCOUNT_NAMES.has(match[1]?.toLowerCase() ?? ""),
  },
  {
    name: "raw Steam user path",
    pattern: /(?:\/home\/|\/Users\/)([A-Za-z0-9._-]+)\//,
    allowed: (match) => ALLOWED_HOME_SEGMENTS.has(match[1]?.toLowerCase() ?? ""),
  },
  {
    name: "raw Steam user path",
    pattern: /[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._-]+)[\\/]/i,
    allowed: (match) => ALLOWED_HOME_SEGMENTS.has(match[1]?.toLowerCase() ?? ""),
  },
];

const files = listFiles();
if (files.length === 0) {
  console.error("[audit-secrets] no files found; refusing to report success");
  process.exit(1);
}

const findings = [];
let scanned = 0;
for (const file of files) {
  const buffer = readFileSync(file);
  if (!isText(buffer)) {
    continue;
  }
  scanned += 1;
  const lines = buffer.toString("utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (/audit-secrets:\s*allow\b/.test(line)) {
      continue;
    }
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (match === null) {
        continue;
      }
      if (rule.allowed?.(match) === true) {
        continue;
      }
      findings.push({
        file: relative(ROOT, file),
        line: index + 1,
        name: rule.name,
        text: line.trim(),
      });
    }
  }
}

if (findings.length > 0) {
  console.error("[audit-secrets] possible secret or personal data in a committed file:");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${String(finding.line)} ${finding.name}: ${finding.text}`);
  }
  console.error(
    "[audit-secrets] replace the value with a synthetic fixture or REDACTED. " +
      "Add `audit-secrets: allow <reason>` only after review.",
  );
  process.exit(1);
}

console.log(`[audit-secrets] ok: ${String(scanned)} text files, no key, AccountName, or user path`);
