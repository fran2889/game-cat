# game-cat

A better way to browse and filter a Steam library: a locally-run web app that reads local Steam data, adds metadata from SteamSpy, the storefront, and Steam reviews, and saves reusable Smart Collections.

Steam-only for now. Later phases add How Long To Beat times, writing Smart Collections back to Steam as Steam Collections, and a desktop wrapper.

## Status

The v1 contract is merged and authoritative:
[docs/specs/game-cat-v1.md](docs/specs/game-cat-v1.md). The server, configuration, data directory,
lock, logging, SQLite schema, local Steam scan, ownership and Metadata Refresh, Library browser, Rule
evaluator, Smart Collections, onboarding, and packaging/lifecycle seams are implemented.

The recorded v1 release verification, including the Linux results and the items that still need a real
Steam client or a macOS/Windows host, is in
[docs/release/v1-checklist.md](docs/release/v1-checklist.md).

## Install

Node 24 or newer and npm with the committed lockfile are required. The supported install is a pinned
Git tag or commit; a floating branch can change the data contract.

```sh
npm install -g github:fran2889/game-cat#v0.1.0
game-cat
```

The install runs the package's `prepare` build, installs the `game-cat` binary, and does not require
a source checkout. Contributors use the development path below.

## Versioning

`v1`, `v2`, `v3`, and `v4` are product phases, not SemVer majors. The package follows ordinary
SemVer independently:

- The v1 phase ships as `0.1.0`.
- Backwards-compatible feature milestones bump the minor version (`0.2.0`, `0.3.0`, ...); fixes bump
  the patch version. Milestones may ship out of order or gain features between them, so future
  versions are not pinned in advance.
- `1.0.0` is declared manually when the contract is stable.
- `DB_SCHEMA_VERSION` is independent of the package version; `game-cat --version` prints both.

`APP_VERSION` is read from `package.json`, which is the single source of truth.

```sh
game-cat --help       # documented flags
game-cat --version    # app version and bundled database schema version
```

The server binds `127.0.0.1:4780` by default. `--port 0` asks the OS for a port; the resolved URL is
printed. The data directory defaults to the OS per-user location and can be set with `--data-dir` or
`GAME_CAT_DATA_DIR`. See [§8.3](docs/specs/game-cat-v1.md#83-data-directory-and-configuration) for
the layout, permissions, and configuration precedence.

## Run

- `--data-dir <path>` overrides `GAME_CAT_DATA_DIR` and the OS default.
- `--port <number>` overrides `GAME_CAT_PORT` and `config.json`.
- `--no-open` disables the browser; a missing TTY or browser is never a startup error.
- `--log-level <level>` overrides `GAME_CAT_LOG_LEVEL` and `config.json`.

The app creates the data directory, applies migrations, prints the URL, opens the browser, and then
shows onboarding or starts the automatic Fetch. One process owns one data directory. A second start
exits `ALREADY_RUNNING` with the owning PID and never opens, migrates, or deletes the lock.

## Lifecycle and logs

`game-cat` is a foreground process. SIGINT, SIGTERM, and SIGHUP stop accepting connections, abort
in-flight upstream requests, finish the short database transaction, mark the active run
`INTERRUPTED` (or finish it), close SQLite, release the lock, and exit 0. Cleanup still running after
5 seconds logs a warning; at 10 seconds the process exits non-zero. A second signal exits
immediately. A hard kill leaves committed SQLite data intact; the next start reconciles the stale run.

Logs are JSON lines in `<data-dir>/logs/game-cat.log`, rotating at 10 MB and keeping three files.
stderr is human-readable on a TTY and JSON otherwise. The Steam Web API key, `AccountName`, raw
upstream payloads, and launch options are never logged.

## Development

Requires Node 24 or newer and npm with the committed lockfile.

```sh
npm ci
npm run dev        # API on 4780, Vite UI on http://127.0.0.1:5173/
npm test           # unit, integration, contract, and packaging metadata
npm run check      # formatting, Markdown, links, and typecheck
npm run build      # server and static client in dist/
npm start          # production-shaped single process
npm run test:e2e   # Playwright with headless Chromium
npm run test:package # pack, global-install, and smoke-test the tarball
npm run test:perf  # fixed 20,000-Game / 1,300-Game performance budgets
npm run contract:golden # recapture tests/contract/golden.json from the HTTP API
npm run lint       # fail on focused/skipped tests, keys, AccountName, or raw user paths
```

`test:perf` builds first, measures p50/p95, and exits non-zero on a missed budget. See
[docs/perf.md](docs/perf.md) for the fixture seeds, recorded results, and the reference runner.

Use a separate data directory while developing:

```sh
GAME_CAT_DATA_DIR="$PWD/.data" npm run dev
```

The library entry point for a desktop wrapper is `dist/server/index.js`:

```js
import { createServer } from "game-cat";

const server = await createServer({
  port: 0,
  openBrowser: false,
  logSink: process.stderr,
  secretStore, // optional: OS keychain instead of config.json
});
console.log(server.url); // readiness: GET /api/status returns 200
await server.close(); // resolves after SQLite closes
```

`npm run check` runs Prettier, Markdownlint, link validation, typecheck, and ESLint. CI runs
`npm run check`, `npm run build`, and `npm test` on Node 24 and 26 (Linux),
E2E on Node 24 with Chromium, and the package smoke test on Node 24. Performance budgets run in the
nightly/manual `perf` workflow (Node 24 with Chromium), not on every pull request. See
[§10.7](docs/specs/game-cat-v1.md#107-ci-and-commands) and the recorded
[release checklist](docs/release/v1-checklist.md).

## Planning

- [GLOSSARY.md](GLOSSARY.md) - the project's vocabulary.
- [docs/specs/game-cat-v1.md](docs/specs/game-cat-v1.md) - the merged, authoritative v1 contract.
- [docs/release/v1-checklist.md](docs/release/v1-checklist.md) - recorded v1 release results and gaps.
- [docs/adr/](docs/adr/) - architecture decisions.
- [docs/research/](docs/research/) - research notes, one file per question, each on its own `research/<slug>` branch.

## License

Copyright (C) 2026 Fran.

game-cat is licensed under the [GNU General Public License, version 3 only](LICENSE), SPDX
`GPL-3.0-only`. The license covers the application code, tooling, and documentation in this
repository. See [ADR 0002](docs/adr/0002-license.md) for the rationale.

SteamSpy data, store metadata, and Cover Art are fetched at runtime and never redistributed (see
[Metadata and Cover Art](GLOSSARY.md)); they remain subject to SteamSpy's and Valve's unresolved
terms, and this project's license grants no rights to them.
