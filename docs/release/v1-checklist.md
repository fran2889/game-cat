# v1 release verification

This note records what was actually verified for the v1 release candidate and what was not. It is the
release evidence for [§10.6 of the v1 contract](../specs/game-cat-v1.md#106-manual-release-checklist)
and the closure evidence for `AC-Q1` through `AC-Q6`. A **verified here** result was produced in the
verification environment described below. A **not verified here** result is a recorded gap, not a
claimed pass.

## Environment

| Item            | Value                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date            | 2026-11-15                                                                                                                                                                                                |
| Branch          | `feat/t39-release`                                                                                                                                                                                        |
| Base            | `integration/v1` at `0fc24f7`                                                                                                                                                                             |
| Host            | Linux x64, 8 vCPU, 7 GB RAM, local disk                                                                                                                                                                   |
| Node / npm      | Node `v26.13.1`, npm `11.20.0`                                                                                                                                                                            |
| Browser         | Playwright Chromium (headless)                                                                                                                                                                            |
| Steam           | No real Steam client, Steam root, `loginusers.vdf`, or Steam Web API key is available on this host                                                                                                        |
| Network         | The original release run made no real Steam, SteamSpy, storefront, or review request; adapters were faked or loopback. The #42 re-run made real storefront and review requests; see the review row below. |
| macOS / Windows | No host available                                                                                                                                                                                         |

The performance reference machine is 4 vCPU, 8 GB RAM, local SSD, Node 24. This host has twice the
vCPU count and Node 26, so the perf numbers below are a smoke check, not the `AC-Q3` sign-off.

## Automated gates

All commands were run from the worktree root after `npm ci`.

| Command                 | Result | Detail                                                                        |
| ----------------------- | ------ | ----------------------------------------------------------------------------- |
| `npm ci`                | PASS   | 397 packages; 0 production advisories                                         |
| `npm run check`         | PASS   | Prettier, Markdownlint, link validation, typecheck, both audits               |
| `npm test`              | PASS   | 44 files, 613 tests (unit, integration, and contract)                         |
| `npm run build`         | PASS   | `dist/client`, `dist/server`, `dist/migrations`                               |
| `npm run test:e2e`      | PASS   | 81 Playwright tests with headless Chromium                                    |
| `npm run test:package`  | PASS   | Pack, temporary-prefix global install, `--help`, `--version`, status, SIGTERM |
| `npm run test:perf`     | PASS   | All nine budgets; results below                                               |
| `npm run audit:tests`   | PASS   | 64 test files; no focused or skipped test                                     |
| `npm run audit:secrets` | PASS   | 197 text files; no key, `AccountName`, or raw user path                       |

`npm audit --omit=dev` reports 0 vulnerabilities. `npm ci` reports 13 dev-only advisories (4 low,
9 moderate); they are recorded here and are not a runtime dependency.

### Performance budgets

Measured with the fixed 20,000-Game and 1,300-Game fixtures (`scripts/perf/run.ts`).

| Measurement                                             | p50      | p95      | Budget |
| ------------------------------------------------------- | -------- | -------- | ------ |
| Rule evaluator, 20,000 Games × 100 Rules                | 64.8 ms  | 71.2 ms  | 500 ms |
| `POST /api/rules/preview`, same fixture                 | 276.1 ms | 335.9 ms | 750 ms |
| `GET /api/games`, 1,300 Games, page size 60             | 5.9 ms   | 7.4 ms   | 200 ms |
| `GET /api/smart-collections`, 20 Collections over 1,300 | 21.5 ms  | 26.2 ms  | 1.0 s  |
| Smart Collection PATCH with 100 Rules                   | 1.8 ms   | 2.2 ms   | 300 ms |
| Autosave PATCH round trip on loopback                   | 3.3 ms   | 4.5 ms   | 350 ms |
| Fetch scheduler overhead per Game/source                | < 0.1 ms | < 0.1 ms | 5 ms   |
| Startup to `/api/status` 200 with an existing database  | 439.1 ms | 461.2 ms | 2.0 s  |
| First Library page LCP after `/api/status` 200          | 280.0 ms | 288.0 ms | 2.5 s  |

The LCP check also asserts the 1,300-Game pagination invariant: exactly 60 cards and `1–60 of 1300`.

### Acceptance-quality matrix

| Criterion | Result here    | Note                                                                                                                                     |
| --------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `AC-Q1`   | PASS           | `npm ci && npm run check`                                                                                                                |
| `AC-Q2`   | PASS           | Unit, integration, contract (Ajv JSON Schema over handlers and §4.2 examples), and E2E suites pass; the guard rejects focus/skip markers |
| `AC-Q3`   | NOT SIGNED OFF | Budgets pass on this host, but it is not the 4 vCPU / 8 GB / Node 24 reference runner                                                    |
| `AC-Q4`   | PARTIAL        | Linux item-by-item results below; real-Steam and macOS/Windows items are not verified                                                    |
| `AC-Q5`   | PASS           | Tracked and new non-ignored text files; `.git` history was not scanned                                                                   |
| `AC-Q6`   | PASS           | `npm run build` from the worktree                                                                                                        |

## Linux checklist

The live checks below used the built CLI (`dist/server/cli.js`) with a synthetic Steam tree from
`tests/helpers/steam-fixture.ts`, plus the packaged tarball. Adapter behaviour was checked with the
fake sources and fake HTTP responses in the integration suites.

| §10.6 item                                                              | Result here                           | Evidence and remaining gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinned Git install on Node 24, launch with `game-cat`                   | PARTIAL                               | `npm run test:package` packs and installs into a temporary prefix, then runs `--help`, `--version`, `GET /api/status`, and SIGTERM on Node 26.13.1. The real `github:` install and Node 24 were **not verified here**. The documented command is `npm install -g github:fran2889/game-cat#v0.1.0`; the tag does not exist yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Data directory, permissions, lock, logs, backups, config                | VERIFIED HERE                         | Live run: data dir, `logs/`, `backups/` are `0700`; `config.json`, database, and log are `0600`; the lock contained the owning PID and was removed on SIGTERM; the log file is JSON lines. Pre-migration backup content and three-file retention are covered by `tests/integration/migrations.test.ts` with a synthetic migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Real Steam root with a second library; manifests, playtime, Collections | VERIFIED HERE (SYNTHETIC)             | Live run discovered two libraries and served Games from both; manifest `installed`, local playtime, and a static Steam Collection were scanned. A real Steam client tree was **not verified here**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `loginusers.vdf` Account selection and multi-Account picker             | VERIFIED HERE (SYNTHETIC)             | Single Account resolved `steam.state = ready` with the PersonaName; multi-Account and picker paths are covered by `tests/integration/config-api.test.ts` and `tests/e2e/onboarding.spec.ts`. A real `loginusers.vdf` was **not verified here**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Real key and first Fetch with progressive Metadata                      | VERIFIED HERE (FAKE SOURCES)          | `tests/integration/refresh-engine.test.ts` runs `all` + Fetch with injected sources and progress counters; `tests/e2e/onboarding.spec.ts` saves a key and starts `all` + Fetch without blocking the UI. A real key and real Steam Web API call were **not verified here**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Delisted, no-SteamSpy-Tags, zero-review, no-storefront Games            | VERIFIED HERE (FAKE RESPONSES)        | `tests/integration/storefront-source.test.ts` covers `success: false`, missing data, and unavailable rows; `tests/integration/steamspy-source.test.ts` covers empty/zeroed Tags; `tests/integration/steam-review-source.test.ts` covers a known zero; `tests/e2e/game-detail.spec.ts` renders all four states. Real upstream responses were **not verified here**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Review endpoint via `IUserReviewsService`; live 200 plus fixture matrix | VERIFIED HERE (LIVE + FAKE RESPONSES) | 2026-11-15: `GET https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/` returned `200` with `response.query_summary` for App 620 without a key (`total_positive` 463678, `total_negative` 6075, `total_reviews` 469753, tier `Overwhelmingly Positive`). The adapter stored `ok`, and the live request accepted `num_per_page: 1` and `filter_offtopic_activity: false`. A follow-up anonymous probe returned `200` for App IDs 100, 870, 620, 570, 730, 10, 4000, and 999999, including the no-trailing-slash form; no `3xx` was observed. The deprecated `/appreviews` endpoint still returned `302 → https://store.steampowered.com/`; it is no longer used. Fixtures cover same-origin and cross-origin 3xx/HTML, `403`, `429`, `5xx`, zero reviews, missing summaries, malformed responses, and inconsistent counts (`tests/integration/steam-review-source.test.ts`). |
| Real-library review Refresh stores `ok` and `unavailable`               | PARTIAL                               | **Not run here.** The curl above exercises one App only; no `game-cat` Refresh against a real library was recorded. Release gate: run a metadata Fetch on a data directory containing App 620 and a zero-review App, then confirm `steam_review_summaries` has `review_status = 'ok'` for 620 and `unavailable` for the zero-review App.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `429` or rate-limit backoff                                             | VERIFIED HERE (FAKE RESPONSES)        | `Retry-After`, `403`, `5xx`, full-jitter retry, and the 15-minute circuit breaker are covered by the Refresh and source integration suites. Rate limits were deliberately not probed on a real network.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Launch for installed / disabled for non-installed                       | VERIFIED HERE (UI)                    | `tests/e2e/game-detail.spec.ts` asserts `steam://rungameid/620` for an installed Game and the disabled state plus title for a non-installed Game. A real Steam client launch was **not verified here**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 1,300-Game page responsiveness and paging                               | VERIFIED HERE                         | `npm run test:perf` met the `GET /api/games` budget (p95 7.4 ms), the LCP budget (p95 288 ms), and the 60-card / `1–60 of 1300` invariant. This host is not the reference runner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Ctrl+C, `kill -9`, and terminal-close recovery                          | VERIFIED HERE                         | SIGINT, SIGTERM, and SIGHUP exit 0 and release the lock; SIGTERM marks an active run `INTERRUPTED` (`tests/integration/cli.test.ts`, `tests/integration/lifecycle.test.ts`). A real `SIGKILL` during an active Fetch left the run committed as `running`; the next start reconciled it to `failed` / `INTERRUPTED` with no data rollback. A closed TTY was simulated with SIGHUP, not an actual terminal close.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Browser URL, request-trust rejection, busy port                         | VERIFIED HERE                         | Live run printed `http://127.0.0.1:<port>/`; `localhost` Host was accepted; a foreign Host returned `403 HOST_NOT_ALLOWED`; a foreign Origin returned `403 ORIGIN_NOT_ALLOWED`; a busy port exited 1 with `PORT_IN_USE`; a second process on the same data directory exited 1 with `ALREADY_RUNNING`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| No Steam file mtime changes during a scan                               | VERIFIED HERE (SYNTHETIC)             | The live run compared size and mtime for every file in both libraries before and after the scan: unchanged. `tests/unit/steam-local.test.ts` asserts the same snapshot. A real Steam tree was **not verified here**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Reproduction notes

- **Install simulation.** `npm pack --json --pack-destination <dir>` followed by
  `npm install -g --prefix <prefix> <tarball>` is what `scripts/verify-package.mjs` runs; it then checks
  `--help`, `--version`, `GET /api/status`, and SIGTERM. The real command remains
  `npm install -g github:fran2889/game-cat#v0.1.0`.
- **Live runtime.** Build, then run `node dist/server/cli.js --data-dir <tmp> --port 0 --no-open` with
  `GAME_CAT_STEAM_ROOT` pointing at a `SteamFixture`. The run above used a second library, manifests,
  `localconfig.vdf`, and a cloud-storage Collection, then sent `POST /api/refresh` with
  `{ "scope": "library" }`.
- **Fetch and adapter cases.** `npm test` runs `tests/integration/refresh-engine.test.ts`,
  `steamspy-source.test.ts`, `storefront-source.test.ts`, and `steam-review-source.test.ts`; `npm run
test:e2e` runs the onboarding, detail, and Launch UI cases.
- **Live review request.** Copy the §6.1 query and send it anonymously:
  `curl -G 'https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/' --data-urlencode 'input_json={"appid":620,"languages":["all"],"purchase_type":1,"review_type":0,"filter":1,"num_per_page":1,"filter_offtopic_activity":false,"display_language":"english"}' --data-urlencode 'format=json'`.
  The response is `{"response":{"query_summary":...}}`; there is no `success` field. Compare the
  returned counts and tier with the public store page for the same App and record any mismatch.
- **Live review Refresh (release gate).** Not run here. Use the live runtime with a library
  containing App 620 and a zero-review App, send `POST /api/refresh` with
  `{ "scope": "metadata", "mode": "fetch" }`, then read `steam_review_summaries`: App 620 should be
  `ok` with counts and tier, and the zero-review App should be `unavailable` with
  `review_total = 0`. Record the date and observed rows in the table above.
- **`kill -9`.** Spawn `tests/fixtures/lifecycle-server.ts <data-dir> abortable`, wait for
  `SOURCE_STARTED`, send `SIGKILL`, then start `dist/server/cli.js` on the same data directory and read
  `refresh_runs`.

### CI review

The workflows were read, not weakened.

- `.github/workflows/ci.yml`: the `check` job runs `npm ci`, `npm run check`, `npm run build`, and
  `npm test` on the Node 24 and Node 26 matrix on `ubuntu-latest`; the `e2e` job runs Node 24 with
  Chromium; the `package` job runs the package smoke test on Node 24.
- Documentation checks are part of `npm run check` (`prettier --check`, `markdownlint-cli2`, and
  `remark --frail`), so both matrix entries cover docs. There is no separate docs workflow to keep in
  sync.
- `.github/workflows/perf.yml` runs the budgets nightly and on `workflow_dispatch` with Node 24 and
  Chromium.
- The only CI-facing change in this ticket is that `npm run check` now also runs `audit:tests` and
  `audit:secrets`; no job, matrix entry, or command was removed.

## Cross-platform results

Neither macOS nor Windows was available. Both remain **not verified** and are listed in
[§11](../specs/game-cat-v1.md#11-open-risks).

### macOS remaining items

- Default data directory `~/Library/Application Support/game-cat` and the macOS Steam root.
- POSIX directory/file modes and the `config.json` permission tightening path.
- Lock behaviour and stale-lock recovery on macOS.
- SIGINT/SIGTERM/SIGHUP shutdown and a real terminal close.
- Browser auto-open and the `--no-open`/headless path.
- `better-sqlite3` install from a prebuilt binary without a compiler.
- The pinned `github:` install and the full E2E/a11y suite with Chromium on macOS.

### Windows remaining items

- Default data directory `%LOCALAPPDATA%\game-cat` and the Windows Steam root candidates.
- Per-user ACLs instead of POSIX modes, including the `CONFIG_PERMISSIONS` path.
- Lock semantics and the single-instance `ALREADY_RUNNING` behaviour on Windows.
- Ctrl+C, console-close, and the absence of SIGHUP.
- `better-sqlite3` prebuild and the `npm.cmd` / Git install path.
- URL/request-trust checks and busy-port handling on Windows.
- The full E2E/a11y suite and 1,300-Game pagination on Windows.

## Secret and `AccountName` audit

`npm run audit:secrets` scans every tracked and new non-ignored text file. It fails on a 32-hex Steam
Web API key, an `AccountName` value outside the synthetic allowlist, or a raw
`/home/<name>/`, `/Users/<name>/`, `C:\Users\<name>\` path outside the documented placeholder list.
`npm run audit:tests` scans the test tree for `.only`, `.skip`, `.fixme`, `.todo`, `xit`, `xdescribe`,
and the focused aliases.

- Result: 197 text files, no key, `AccountName`, or raw user path; 64 test files, no focused or skipped
  test.
- The live run's generated JSONL log was also checked: no `AccountName`, no account name value, and no
  key. The integration suites assert the same for a known key (`tests/integration/config-api.test.ts`,
  `tests/integration/access-log.test.ts`, `tests/unit/logging.test.ts`).
- Limitation: `.git` history is not scanned. Only the working tree and new non-ignored files are.

## Release tag and install

The candidate version is `0.1.0`, matching the v1 phase and the `#v0.1.0` install example in
[§8.2](../specs/game-cat-v1.md#82-install-and-start). The tag was **not created or pushed** because this
pull request is not merged yet.

After merge, create the tag on the merged commit and publish the install command:

```sh
git tag -a v0.1.0 -m "game-cat 0.1.0 (v1 phase)"
git push origin v0.1.0
npm install -g github:fran2889/game-cat#v0.1.0
game-cat --version   # game-cat 0.1.0 (database schema 1)
```

A floating branch is not a supported install target; pin the tag or a commit.

## Release blockers fixed in this ticket

- The v1 phase ships as package version `0.1.0`. Product phase names (`v1`, `v2`, ...) are
  milestones, not SemVer majors; `package.json` is the single version source and `APP_VERSION` reads it.
- The README install command did not match §8.2 and did not link the manual checklist. Both are fixed.
- There was no automated guard against focused/skipped acceptance tests. `audit:tests` now runs in
  `npm run check`.
- There was no repeatable secret/`AccountName` audit. `audit:secrets` now runs in `npm run check`.
- The Linux checklist and cross-platform gaps had no recorded result. This note and the §10.6/§11 links
  record them.

No data, API, rule, or runtime semantics were changed.

## Remaining for a human

1. Run the real Linux checklist on a machine with a Steam client, a second library, and a Steam Web API
   key: real install, real scan, real `all` + Fetch, real upstream delisted/no-Tags/zero-review/
   no-storefront responses, a live review request, and a real Steam launch.
2. Run `npm run test:perf` on the 4 vCPU / 8 GB / Node 24 reference machine and sign off `AC-Q3`.
3. Run the full checklist and E2E suite on macOS and Windows and record the results.
4. Install from `github:fran2889/game-cat#v0.1.0` on Node 24 after the tag exists and confirm the
   packaged `prepare` build, binary, and `--version`.
5. Create and push `v0.1.0` after this pull request merges.
6. Verify issue #41 on a real Library: after a Refresh, affected Games report `store_status = 'ok'`
   (or a documented `unavailable`/`stale`/`error` with a truthful cause) and there are no unexplained
   App ID mismatch errors. This is a release gate, not a code-only check.
