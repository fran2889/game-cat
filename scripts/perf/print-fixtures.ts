import { validateRules } from "../../src/shared/rules.ts";
import {
  fixtureChecksum,
  generatePerfGames,
  PERF_1300,
  PERF_20000,
  readRulesFixture,
} from "./fixtures.ts";

/** Print the committed performance fixtures and their pinned hashes. */
const games20000 = generatePerfGames(PERF_20000.games, PERF_20000.seed, PERF_20000.baseAppId);
const games1300 = generatePerfGames(PERF_1300.games, PERF_1300.seed, PERF_1300.baseAppId);
const rules = readRulesFixture();
const validated = validateRules(rules.rules);

console.log(
  `fixture-20000  games=${PERF_20000.games} seed=0x${PERF_20000.seed.toString(16)} baseAppId=${PERF_20000.baseAppId}`,
);
console.log(`               sha256=${fixtureChecksum(games20000)}`);
console.log(
  `fixture-1300   games=${PERF_1300.games} seed=0x${PERF_1300.seed.toString(16)} baseAppId=${PERF_1300.baseAppId}`,
);
console.log(`               sha256=${fixtureChecksum(games1300)}`);
console.log(`rules          name="${rules.name}" count=${rules.rules.length}`);
console.log(`               validationErrors=${Object.keys(validated.fieldErrors).length}`);
if (
  validated.rules.length !== rules.rules.length ||
  Object.keys(validated.fieldErrors).length > 0
) {
  process.exitCode = 1;
}
