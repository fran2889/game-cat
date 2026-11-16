import { noFocusedOrSkippedTests } from "./rules/no-focused-or-skipped-tests.js";
import { noSecretValues } from "./rules/no-secret-values.js";
import { textProcessor } from "./lib/text-processor.js";

/** Local ESLint plugin for the release audits that used to be scripts. */
export const gameCatPlugin = {
  meta: {
    name: "game-cat",
    version: "1.0.0",
  },
  processors: {
    text: textProcessor,
  },
  rules: {
    "no-focused-or-skipped-tests": noFocusedOrSkippedTests,
    "no-secret-values": noSecretValues,
  },
};
