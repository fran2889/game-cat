import { writeFileSync } from "node:fs";
import { captureContractResponses } from "../../tests/helpers/contract-harness.ts";

/**
 * Recapture `tests/contract/golden.json` from the current HTTP API.
 *
 * Run `npm run contract:golden` after an intentional response change, review
 * the diff, and commit both the code and the fixtures together. A schema that
 * drifts without a fixture update fails the contract suite.
 */
const golden = await captureContractResponses();
const target = new URL("../../tests/contract/golden.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(golden, null, 2)}\n`);
console.log(`Wrote ${Object.keys(golden).length} responses to ${target.pathname}`);
const schemas = new Set(
  Object.values(golden)
    .map((response) => response.schema)
    .filter((schema) => schema !== undefined),
);
console.log(`Schemas covered: ${schemas.size}`);
