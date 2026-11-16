# Defer `node:sqlite`; keep `better-sqlite3` for v1

## Status

Accepted (2026-11-16). Records [#69](https://github.com/fran2889/game-cat/issues/69), a child of
[#50](https://github.com/fran2889/game-cat/issues/50). Leaves [spec §1.5](../specs/game-cat-v1.md#15-architecture)
and the [§11 open-risk table](../specs/game-cat-v1.md#11-open-risks) unchanged.

## Context

[ADR 0004](0004-libraries-over-boilerplate.md) forbids new native dependencies and grandfathers
`better-sqlite3`; replacing it with Node's built-in `node:sqlite` was carved out as a separate,
optional decision. The prize is real: the built-in module removes the last native addon from the
install, the Git-install `prepare` path, and the packaging chain, and it retires the
[§11 "Native SQLite prebuilds" risk](../specs/game-cat-v1.md#11-open-risks) instead of gating every
release on it.

The project uses a small part of the driver API. Across `src/` there are 100 `db.prepare()` call
sites, 11 `db.transaction()` call sites, 5 `db.pragma()` calls, and `db.exec()`; there is no
`.pluck()`, `.raw()`, `.iterate()`, `.columns()`, `safeIntegers`, named parameter, `BLOB` column, or
inspection of SQLite error codes. The schema relies on `foreign_keys = ON` and `ON DELETE CASCADE`,
the connection settings are [§3.1](../specs/game-cat-v1.md#31-connection-settings), and the
[§3.2 migration runner](../specs/game-cat-v1.md#32-migration-table-and-runner) depends on
`BEGIN IMMEDIATE`, `PRAGMA user_version`, and a pre-migration `VACUUM INTO` copy that includes
committed WAL content.

Two facts frame the decision:

- **`node:sqlite` is not stable.** It is unflagged since Node 22.13/23.4, but the module's documented
  stability is `1` (experimental) in Node 24.0.0, `1.1` in Node 24.11, and `1.2` (release candidate)
  by Node 24.22 and Node 26.0. The project declares `engines.node: ">=24"` and tests Node 24 and 26,
  so "the Node version the project already requires" includes versions where the module is
  experimental.
- **Kysely has no first-party `node:sqlite` dialect.** [ADR 0004](0004-libraries-over-boilerplate.md)
  and the SQL strand put Kysely over this connection. As of Kysely 0.29.9 its Node SQLite dialect is
  the `better-sqlite3` one; `node:sqlite` is served only by community dialects
  (`kysely-node-native-sqlite`, currently 1.1.0), which would be a new dependency decision of its own.

All statements below were verified on Linux with Node 24.22.3 and Node 26.13.1. Both drivers link
SQLite 3.54.1, so the measurements compare the bindings, not the SQL engine.

## Measurements

Method: the project's own fixture generator and read paths, not a synthetic benchmark.

- Fixtures: `scripts/perf/fixtures.ts` at the committed seeds (`library-20000`, `library-1300`) and
  the committed 100-Rule Smart Collection, seeded through `seedPerfLibrary()` into two data
  directories.
- Functions: `readLibrary()` (the `v_games` projection plus all Tags), the in-memory evaluator on top
  of it (`POST /api/rules/preview` work without HTTP), `GamesRepository.list()` for
  `GET /api/games?page=1&pageSize=60`, and `SmartCollectionsRepository.list()` for
  `GET /api/smart-collections`. The repositories were instantiated with a `DatabaseSync` connection
  for the `node:sqlite` arm, so the SQL text, parameters, and result shaping are identical.
- Also measured: 20,000 prepared-statement inserts in one transaction, and the pre-migration
  `VACUUM INTO` copy of the 20,000-Game database.
- Each arm ran in its own process: 3 warm-ups plus 12 measured iterations for the Library and
  raw-select paths, 2 plus 8 for the Library-plus-evaluator path, 5 plus 40 for the Games page, 3
  plus 20 for Smart Collections, and 2 plus 5 for the write and backup paths. Every arm was repeated
  five times per driver, alternating the drivers. The table reports the median of the five per-run
  p50/p95 values.
- Host: Linux, 8 vCPU, 7 GB RAM, shared and noisy; **not** the §10.5 reference runner, so treat the
  absolute numbers as informational and the ratios as the result. Node 24.22.3 is shown because it is
  the oldest supported line.

| Measurement (medians of 5 runs)                         | `better-sqlite3` p50/p95 | `node:sqlite` p50/p95 | Ratio (p50) |
| ------------------------------------------------------- | ------------------------ | --------------------- | ----------- |
| `SELECT * FROM v_games`, 20,000 rows                    | 104.8 / 173.3 ms         | 172.2 / 213.5 ms      | 1.64x       |
| `readLibrary()`, 20,000 Games with Tags                 | 303.4 / 403.5 ms         | 559.5 / 643.6 ms      | 1.84x       |
| Library read + 100-Rule evaluator (preview work)        | 368.7 / 488.4 ms         | 565.4 / 748.3 ms      | 1.53x       |
| `GET /api/games`, 1,300 Games, page size 60             | 5.9 / 7.7 ms             | 6.3 / 8.7 ms          | 1.07x       |
| `GET /api/smart-collections`, 20 Collections over 1,300 | 24.1 / 33.0 ms           | 46.1 / 73.5 ms        | 1.91x       |
| 20,000 prepared-statement inserts in one transaction    | 45.9 / 64.2 ms           | 25.3 / 38.2 ms        | 0.55x       |
| `VACUUM INTO` backup of the 20,000-Game database        | 84.2 / 106.3 ms          | 97.4 / 111.0 ms       | 1.16x       |

Node 26.13.1 repeats in the same direction: `readLibrary()` 1.78x slower, Smart Collections 1.6x
slower, the Games page within noise of parity, inserts roughly 1.5x faster, and `VACUUM INTO` about
1.2x slower. Both drivers returned identical results on every check: 20,000 Library rows and targets,
1,300 total Games with 60 rows on the page, 20 Collections, and 12,900 preview matches.

The regression is per-row materialisation, not SQL planning: the same SQLite version executes the
same SQL, the 60-row Games page is unaffected, and the cost scales with rows returned. The read path
is the hot one — `readLibrary()` also backs `matchCount` and Smart Collection membership — while the
write path gets faster and the backup path is about 1.2x slower (up to ~1.4x in noisy runs).

Projected against the recorded reference-class preview result in
[docs/perf.md](../perf.md#recorded-results) (p95 374.4 ms, budget 750 ms), a 1.5-1.8x library read would
land around 550-650 ms p95: inside the budget, but it would consume most of the preview headroom. That
projection is an estimate, not a reference-runner measurement.

## Decision

Do not adopt `node:sqlite` for v1. Keep `better-sqlite3` through the libraries refactor and the v1
release, and keep the existing [§11](../specs/game-cat-v1.md#11-open-risks) prebuild gate as the
mitigation for the install risk. Revisit this decision as a packaging change after the SQL strand
lands, and only when a trigger below fires.

`node:sqlite` is functionally capable of the current SQL surface. The reasons to wait are not one
blocker but four costs that would land during a refactor whose premise is "same behaviour, less
plumbing":

1. **Stability.** The module is a release candidate in Node 24.22/26 and experimental in Node 24.0.
   Adopting it would have to raise `engines.node` to a 24.x patch line and amend
   [§8.2](../specs/game-cat-v1.md#82-install-and-start) — a user-visible prerequisite change, not a
   refactor.
2. **The hot read path regresses 1.5-1.9x.** The preview and Smart Collection budgets are v1
   acceptance criteria ([§10.5](../specs/game-cat-v1.md#105-performance-tests)); spending most of the
   preview headroom to remove a grandfathered dependency is a poor trade in the same release that
   introduces a query builder.
3. **Kysely has no first-party driver.** The SQL strand is explicitly Kysely over the existing
   connection. Swapping the driver first would either block the SQL strand or force an unreviewed
   community dialect, which contradicts ADR 0004's library constraints.
4. **The API gaps are small but real.** They are mechanical to close, but they are production code
   and must be pinned by tests (below).

Reopen when any of these is true:

- a supported Linux, macOS, or Windows target loses its `better-sqlite3` prebuilt binary — the
  [§11](../specs/game-cat-v1.md#11-open-risks) release blocker is the case where a slower driver is
  the lesser evil;
- `node:sqlite` reaches stability 2 in the Node line the project supports, so the floor does not move;
- Kysely ships a first-party `node:sqlite` dialect, removing cost 3.

## What a swap would and would not carry over

Verified on Node 24.22.3 and 26.13.1 unless noted:

| Area                     | Finding                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepared statements      | Covered. `prepare()`/`run()`/`get()`/`all()` have the same semantics; statements are reusable and `changes` is returned. Both return `undefined` from `get()` for no row.                                                                                                                                                                 |
| WAL mode                 | Covered. `exec("PRAGMA journal_mode = WAL")` applies it and `prepare("PRAGMA journal_mode").get()` reports `wal`. The default is `delete`, so the §3.2 guarantee that `DB_UNRECOGNIZED`/`DB_SCHEMA_TOO_NEW` are detected before WAL rewrites the file is preserved.                                                                       |
| Connection pragmas       | Covered with a mechanical change: there is no `db.pragma()` helper, so `foreign_keys`, `busy_timeout`, `synchronous`, and `user_version` move to `exec()`/`prepare()`. `foreign_keys` is already ON by default; `busy_timeout` reads as column `timeout`.                                                                                 |
| Explicit transactions    | Covered. `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` via `exec()` work, and `db.isTransaction` is available. **Not covered:** the `db.transaction(fn)` helper — its return value, exception rethrow, nesting/savepoint behaviour, and "transaction inside transaction" rules must be reimplemented at the 11 call sites or in one small helper. |
| `VACUUM INTO` backup     | Covered and verified end to end: a row committed to WAL immediately before the copy is present in the backup, and `PRAGMA integrity_check` on it returns `ok`. `sqlite.backup()` exists but returns a Promise, so it cannot replace the synchronous pre-migration path; `VACUUM INTO` stays.                                              |
| Error handling           | Different shape. Throws `Error` with `code: "ERR_SQLITE_ERROR"`, a numeric `errcode` (for example `1555` for a primary-key conflict), and `errstr`; `better-sqlite3` throws `SqliteError` with a string `code`. The project only surfaces `.message`, so this is low risk, but tests that assert messages need review.                    |
| Values                   | Rows are null-prototype objects. `BLOB` reads as `Uint8Array` rather than `Buffer` (the schema has no BLOBs). Integers outside the safe range throw `ERR_OUT_OF_RANGE` unless `readBigInts` is enabled; App IDs, timestamps, and counts are safe.                                                                                         |
| Binding                  | Positional binding matches. Booleans are accepted (written as 1/0) where `better-sqlite3` rejects them. **Version drift:** binding `undefined` throws `TypeError` on 24.22 but binds `NULL` on 26.13, and `undefined` appears nowhere in the current queries. Named parameters are unused.                                                |
| Unused APIs              | `loadExtension`, sessions/changesets, user-defined functions and aggregates, `.raw()`, `.pluck()`, `.columns()`, and `safeIntegers` are not used and were not evaluated.                                                                                                                                                                  |
| Kysely driver            | Not covered by Kysely 0.29.9. A first-party dialect, a reviewed community dialect, or a hand-written driver is prerequisite work.                                                                                                                                                                                                         |
| Test and packaging suite | Not run. The 524 Vitest cases, the package smoke test, and the reference-runner perf suite are the gate for a follow-up, not evidence in this ADR. Windows and macOS were not exercised.                                                                                                                                                  |

## Considered Options

- **Adopt now, before the SQL strand.** Rejected: it moves the Node floor during a refactor, spends
  the preview budget's headroom, and leaves Kysely without a driver.
- **Adopt after the SQL strand, inside the libraries refactor.** Rejected for v1: it is a second
  driver change stacked on a query-builder change, so a regression could not be attributed, and the
  module is still a release candidate on the supported floor.
- **Defer with explicit reopen triggers (chosen).** `better-sqlite3` keeps its grandfathered status
  and its release gate; the install risk stays documented rather than removed.
- **Hide the driver behind a small adapter now, so the swap is later free.** Rejected: the app already
  passes the connection object directly, and a bespoke adapter is exactly the plumbing ADR 0004 is
  removing. `AppDatabase.raw` is a sufficient seam for a follow-up.
- **Use `sqlite.backup()` instead of `VACUUM INTO`.** Rejected: it is asynchronous, so it does not fit
  the synchronous startup migration sequence, and `VACUUM INTO` already produces a consistent copy
  including WAL content.

## Consequences

- No dependency is added or removed; `better-sqlite3` and `@types/better-sqlite3` stay.
- The [§11](../specs/game-cat-v1.md#11-open-risks) native-prebuild and Git-install risks remain
  release gates. `better-sqlite3` 13.2.0 installs 27 MB, including eight platform prebuilds, and still
  declares an install script, so a missing prebuild falls back to `node-gyp` and a C/C++ toolchain in
  both `npm ci` and the Git install's dependency step. `node:sqlite` would remove that step but not
  the `prepare` build itself, which still needs Vite and TypeScript from devDependencies.
- The read-path regression is recorded here, so a future proposal cannot claim parity. Any acceptance
  must include a reference-runner measurement of `POST /api/rules/preview` and
  `GET /api/smart-collections`.

### Follow-up outline, if this is revisited and accepted

1. **Raise the floor.** Pick the Node 24.x patch line where the module is a release candidate, update
   `engines`, [§8.2](../specs/game-cat-v1.md#82-install-and-start), the CI matrix, and `@types/node`;
   amend [§1.5](../specs/game-cat-v1.md#15-architecture) and [§3.1](../specs/game-cat-v1.md#31-connection-settings).
2. **Characterise first.** Run the unchanged Vitest, contract, and package suites against the new
   driver before deleting `better-sqlite3`, and pin the transaction and pragma helper behaviour with
   tests, including a failing migration that must roll back and leave its backup.
3. **Replace the driver.** Change `AppDatabase.raw` and the 17 server files plus four tests and one
   perf script that reference the `better-sqlite3` type; add the `transaction()` and `pragma()`
   helpers; map `errcode` where needed.
4. **Settle the Kysely driver.** Prefer a first-party dialect; otherwise review a community dialect
   against ADR 0004's constraints before adding it.
5. **Re-measure.** Run `npm run test:perf` on the reference runner and require the §10.5 preview and
   Smart Collection budgets to pass with headroom; if preview fails, do not proceed.
6. **Prove the install win.** Run the package smoke test and a Git install on Linux, macOS, and
   Windows without a C/C++ toolchain, then remove the native-prebuild row from
   [§11](../specs/game-cat-v1.md#11-open-risks) and the prebuild item from the release checklist.
