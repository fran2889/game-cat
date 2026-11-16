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
import { originalLines } from "../lib/text-processor.js";

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

const ALLOWED_LINE = /audit-secrets:\s*allow\b/;

const RULES = [
  {
    messageId: "apiKey",
    pattern: /\b[0-9A-Fa-f]{32}\b/,
  },
  {
    messageId: "accountName",
    pattern: /["']AccountName["']\s+["']([^"']*)["']/,
    allowed: (match) => ALLOWED_ACCOUNT_NAMES.has((match[1] ?? "").toLowerCase()),
  },
  {
    messageId: "userPath",
    pattern: /(?:\/home\/|\/Users\/)([A-Za-z0-9._-]+)\//,
    allowed: (match) => ALLOWED_HOME_SEGMENTS.has((match[1] ?? "").toLowerCase()),
  },
  {
    messageId: "userPath",
    pattern: /[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._-]+)[\\/]/i,
    allowed: (match) => ALLOWED_HOME_SEGMENTS.has((match[1] ?? "").toLowerCase()),
  },
];

export const noSecretValues = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow real API keys, AccountName values, and raw Steam user paths in tracked files",
    },
    schema: [],
    messages: {
      apiKey: "Possible Steam Web API key (32 hexadecimal characters).",
      accountName:
        "AccountName value is not a documented synthetic fixture. Use REDACTED or an allowlisted value.",
      userPath:
        "Raw Steam user path. Use a documented placeholder such as /home/tester/ or REDACTED.",
    },
  },
  create(context) {
    const lines = originalLines(context.sourceCode.text);

    return {
      Program() {
        for (const [index, line] of lines.entries()) {
          if (ALLOWED_LINE.test(line)) {
            continue;
          }
          for (const rule of RULES) {
            const match = rule.pattern.exec(line);
            if (match === null || rule.allowed?.(match) === true) {
              continue;
            }
            context.report({
              loc: { start: { line: index + 1, column: match.index }, end: null },
              messageId: rule.messageId,
            });
          }
        }
      },
    };
  },
};
