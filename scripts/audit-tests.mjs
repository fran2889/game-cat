// Release guard for AC-Q2: no focused or skipped acceptance test.
//
// A release candidate must run every test. `.only` silently drops the rest of a
// file, and `.skip`/`.fixme`/`.todo` hide an acceptance test from the suite.
// This scan fails on any of them unless the line carries an explicit
// `audit-tests: allow-<focus|skip> <reason>` comment.
//
// Scope is the tests tree only: this script's own pattern strings are not test
// source. Run by `npm run check`.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();
const TEST_DIR = join(ROOT, "tests");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js", ".jsx"]);

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function listTestFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "tests"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return output
      .split("\n")
      .filter(Boolean)
      .map((file) => join(ROOT, file))
      .filter((file) => SOURCE_EXTENSIONS.has(extname(file)) && statSync(file).isFile());
  } catch {
    return walk(TEST_DIR);
  }
}

const RULES = [
  {
    name: "focused test",
    pattern: /\b(?:test|it|describe|context|suite)\.only\s*\(/,
    allowance: /audit-tests:\s*allow-focus\b/,
  },
  {
    name: "focused test",
    pattern: /\b(?:fit|fdescribe|fcontext)\s*\(/,
    allowance: /audit-tests:\s*allow-focus\b/,
  },
  {
    name: "skipped test",
    pattern: /\b(?:test|it|describe|context|suite)\.(?:skip|fixme|todo)\s*\(/,
    allowance: /audit-tests:\s*allow-skip\b/,
  },
  {
    name: "skipped test",
    pattern: /\b(?:xit|xdescribe|xcontext)\s*\(/,
    allowance: /audit-tests:\s*allow-skip\b/,
  },
];

const files = listTestFiles();
if (files.length === 0) {
  console.error("[audit-tests] no test files found; refusing to report success");
  process.exit(1);
}

const findings = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) {
        continue;
      }
      const context = lines.slice(Math.max(0, index - 2), index + 1).join("\n");
      if (rule.allowance.test(context)) {
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
  console.error("[audit-tests] focused or skipped tests are not allowed in a release candidate:");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${String(finding.line)} ${finding.name}: ${finding.text}`);
  }
  console.error(
    "[audit-tests] remove the modifier, or annotate the line with " +
      "`audit-tests: allow-skip <reason>` when it is a documented platform-only test.",
  );
  process.exit(1);
}

console.log(`[audit-tests] ok: ${String(files.length)} test files, no focused or skipped tests`);
