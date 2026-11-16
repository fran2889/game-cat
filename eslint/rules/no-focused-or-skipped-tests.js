// Release guard for AC-Q2: no focused or skipped acceptance test.
//
// A release candidate must run every test. `.only` silently drops the rest of a
// file, and `.skip`/`.fixme`/`.todo` hide an acceptance test from the suite.
// A finding fails unless the line or one of the two lines above it carries an
// explicit `audit-tests: allow-<focus|skip> <reason>` comment.
import { originalLines } from "../lib/text-processor.js";

const FOCUS_ALLOWANCE = /audit-tests:\s*allow-focus\b/;
const SKIP_ALLOWANCE = /audit-tests:\s*allow-skip\b/;

const RULES = [
  {
    kind: "focus",
    pattern: /\b(?:test|it|describe|context|suite)\.only\s*\(/,
    allowance: FOCUS_ALLOWANCE,
  },
  {
    kind: "focus",
    pattern: /\b(?:fit|fdescribe|fcontext)\s*\(/,
    allowance: FOCUS_ALLOWANCE,
  },
  {
    kind: "skip",
    pattern: /\b(?:test|it|describe|context|suite)\.(?:skip|fixme|todo)\s*\(/,
    allowance: SKIP_ALLOWANCE,
  },
  {
    kind: "skip",
    pattern: /\b(?:xit|xdescribe|xcontext)\s*\(/,
    allowance: SKIP_ALLOWANCE,
  },
];

export const noFocusedOrSkippedTests = {
  meta: {
    type: "problem",
    docs: {
      description: "disallow focused or skipped tests in the release test suite",
    },
    schema: [],
    messages: {
      focused:
        "Focused test is not allowed: {{text}}. Remove the focus modifier, or annotate the line with `audit-tests: allow-focus <reason>`.",
      skipped:
        "Skipped test is not allowed: {{text}}. Remove the skip modifier, or annotate the line with `audit-tests: allow-skip <reason>`.",
    },
  },
  create(context) {
    const lines = originalLines(context.sourceCode.text);

    return {
      Program() {
        for (const [index, line] of lines.entries()) {
          const surrounding = lines.slice(Math.max(0, index - 2), index + 1).join("\n");
          for (const rule of RULES) {
            const match = rule.pattern.exec(line);
            if (match === null || rule.allowance.test(surrounding)) {
              continue;
            }
            context.report({
              loc: { start: { line: index + 1, column: match.index }, end: null },
              messageId: rule.kind === "focus" ? "focused" : "skipped",
              data: { text: line.trim() },
            });
          }
        }
      },
    };
  },
};
