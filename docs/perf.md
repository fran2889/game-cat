# Performance budgets

The v1 performance budgets in [the specification](specs/game-cat-v1.md) are enforced by a
repeatable harness:

```sh
npm ci
npx playwright install chromium   # once, for the LCP measurement
npm run test:perf
```

`test:perf` runs `npm run build` first, then `tsx scripts/perf/run.ts`. It prints p50 and p95 for
every budget and exits non-zero if any p95 is over budget. The reference runner is **4 vCPU, 8 GB
RAM, local SSD, Node 24**; a different host is reported by the harness and makes the numbers
informational rather than a release gate.

## What is measured

| Measurement                                             | Budget (p95) |
| ------------------------------------------------------- | ------------ |
| Rule evaluator, 20,000 Games × 100 Rules                | 500 ms       |
| `POST /api/rules/preview`, same fixture                 | 750 ms       |
| `GET /api/games`, 1,300 Games, page size 60             | 200 ms       |
| `GET /api/smart-collections`, 20 Collections over 1,300 | 1.0 s        |
| Smart Collection PATCH with 100 Rules                   | 300 ms       |
| Autosave PATCH round trip on loopback                   | 350 ms       |
| First Library page LCP after `/api/status` 200          | 2.5 s        |
| Startup to `/api/status` 200 with an existing database  | 2.0 s        |
| Fetch scheduler overhead per Game/source                | 5 ms         |

The API rows use a real loopback HTTP server. The evaluator row times only the pure in-memory
evaluation, after the Library projection is loaded. The LCP row uses Chromium and also asserts the
pagination invariant: the 1,300-Game Library renders exactly 60 cards and shows `1–60 of 1300`.
Startup spawns the built CLI with an existing database and times the first `/api/status` 200. The
scheduler row starts a Metadata Fetch over 1,300 Games × 3 fake sources and divides the wall time
by the 3,900 Game/source items.

## Fixtures

Both fixtures are deterministic and generated from committed seeds by
[`scripts/perf/fixtures.ts`](../scripts/perf/fixtures.ts). Nothing depends on `Math.random`, the
clock, or the network.

| Fixture         | Games  | Seed       | SHA-256 (first 12) |
| --------------- | ------ | ---------- | ------------------ |
| `library-20000` | 20,000 | `0x382000` | `0512355f39b8`     |
| `library-1300`  | 1,300  | `0x381300` | `0903cdf5053b`     |

The 100-Rule Smart Collection is the committed data file
[`tests/fixtures/perf/rules-100.json`](../tests/fixtures/perf/rules-100.json): 34 AND, 33 OR, and 33
NOT Rules. It deliberately references Tags that do not exist, so OR and NOT do not short-circuit
and the evaluator performs the full per-Game work. The list/UI fixture also seeds 20 saved Smart
Collections.

Regenerate or verify the fixtures with:

```sh
npm run perf:fixtures
```

That command prints the counts, seeds, SHA-256 hashes, and the Rule validation result. The unit test
`tests/unit/perf-fixtures.test.ts` pins the hashes, so changing the generator changes the baseline
and must be an explicit, reviewed change.

## Recorded results

Recorded on 2026-11-15 with Node 26.13.1 on an 8 vCPU / 7 GB Linux machine. This is **not** the
reference runner; it has twice the vCPU count, so treat the margin as a smoke check rather than the
release gate. The reference machine must run the same command before AC-Q3 is signed off.

| Measurement                                             | p50      | p95       | Budget |
| ------------------------------------------------------- | -------- | --------- | ------ |
| Rule evaluator, 20,000 Games × 100 Rules                | 80.7 ms  | 95.3 ms   | 500 ms |
| `POST /api/rules/preview`, same fixture                 | 314.9 ms | 374.4 ms  | 750 ms |
| `GET /api/games`, 1,300 Games, page size 60             | 6.9 ms   | 16.0 ms   | 200 ms |
| `GET /api/smart-collections`, 20 Collections over 1,300 | 25.8 ms  | 35.7 ms   | 1.0 s  |
| Smart Collection PATCH with 100 Rules                   | 1.7 ms   | 2.6 ms    | 300 ms |
| Autosave PATCH round trip on loopback                   | 4.0 ms   | 4.9 ms    | 350 ms |
| Fetch scheduler overhead per Game/source                | < 0.1 ms | < 0.1 ms  | 5 ms   |
| Startup to `/api/status` 200 with an existing database  | 506.8 ms | 766.0 ms  | 2.0 s  |
| First Library page LCP after `/api/status` 200          | 696.0 ms | 1040.0 ms | 2.5 s  |

## Continuous integration

`npm run test:perf` is not part of pull-request CI: a shared or noisy runner would make timing
budgets flaky. The dedicated nightly job is
[`.github/workflows/perf.yml`](../.github/workflows/perf.yml) (`schedule` plus manual
`workflow_dispatch`). It runs on `ubuntu-latest` with Node 24 and Chromium. To run the same job by
hand:

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:perf
```

## Why the numbers stay correct

The optimizations that keep the budgets green do not change membership or ordering:

- Rules are compiled once per evaluation. Rule-value normalization, date conversion, and App ID
  list construction happen once instead of once per Game, and list Fields are compared through a
  per-Game cached Set. `testRule` still exposes the single-Rule predicate, and the equivalence test
  compares the compiled matcher with the literal §5.5.2 grouping.
- JSON-backed Fields in the evaluator projection (`platforms`, `genres`, `categories`,
  `developers`, `publishers`) are parsed on first access and cached. A Rules array that does not read
  a Field never parses it; the values when read are identical.
- `GET /api/games` pages in SQL before loading Tags for the visible page, and `matchCount` reads the
  Library once per list request. Pagination is never moved to the client.

The schema and the API contract are unchanged.
