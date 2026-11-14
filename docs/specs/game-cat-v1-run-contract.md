# game-cat v1: run and distribution contract

Status: draft for [#7](https://github.com/fran2889/game-cat/issues/7), ready to fold into the v1 spec
([#8](https://github.com/fran2889/game-cat/issues/8)).

> **Pending #4 deltas.** [#4](https://github.com/fran2889/game-cat/issues/4) replaces Enrichment
> with **Metadata**, splits `game_enrichment` into the three source-named tables, removes metadata
> TTLs, and adds Steam reviews as a third metadata source. This section uses that vocabulary. The
> Fetch/Full Refresh split below refines #4's "every explicit refresh fetches every selected Game"
> rule; #8 folds both.

This section defines how a user installs, starts, configures, and stops game-cat v1, how runs are
triggered and recovered, and which parts of that contract the v4 desktop wrapper must preserve. It
does not define the HTTP API, the rule grammar, or the UI; those belong to
[#3](https://github.com/fran2889/game-cat/issues/3),
[#4](https://github.com/fran2889/game-cat/issues/4), and
[#6](https://github.com/fran2889/game-cat/issues/6). The API, schema, and security deltas this
contract requires are listed in [§11](#11-deltas-for-8).

Related contracts:

- [v1 data model and HTTP API](game-cat-v1-data-model-and-api.md)
- [v1 rule grammar and evaluator](game-cat-v1-rule-grammar.md)
- [#6 UI decisions](https://github.com/fran2889/game-cat/issues/6#issuecomment-6880759676)
- [Steam local library: file formats and discovery](https://github.com/fran2889/game-cat/blob/research/steam-local-library/docs/research/steam-local-library.md)
- [Steam metadata sources: the v1 metadata contract](https://github.com/fran2889/game-cat/blob/research/metadata-sources/docs/research/metadata-sources.md)
- [Architecture decision: Steam Web API for the full library roster](../adr/0001-steam-web-api-for-library-ownership.md)
- [Architecture decision: GPL-3.0-only](../adr/0002-license.md)

## Contents

- [1. Decisions](#1-decisions)
- [2. Install and start](#2-install-and-start)
- [3. Data directory and configuration](#3-data-directory-and-configuration)
- [4. Network contract](#4-network-contract)
- [5. Startup sequence](#5-startup-sequence)
- [6. First run and account selection](#6-first-run-and-account-selection)
- [7. Run model: Fetch and Full Refresh](#7-run-model-fetch-and-full-refresh)
- [8. Logging](#8-logging)
- [9. Process lifecycle](#9-process-lifecycle)
- [10. v4 wrapper constraints](#10-v4-wrapper-constraints)
- [11. Deltas for #8](#11-deltas-for-8)
- [12. Acceptance checks](#12-acceptance-checks)
- [13. Open questions and risks](#13-open-questions-and-risks)

## 1. Decisions

The decisions below were settled on #7 on 2026-11-14.

| Topic             | Decision                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install           | `npm install -g github:fran2889/game-cat#<tag-or-commit>`, then `game-cat`. A source checkout is the contributor path. No npm registry publish, installers, or Docker in v1.                                                                                                                                        |
| Runtime           | Node `>=24` and npm with the committed lockfile. `.nvmrc` is 24; app CI tests 24 and 26. The CLI refuses to start on an older Node.                                                                                                                                                                                 |
| Data directory    | OS-standard per-user directory, overridable with `--data-dir` or `GAME_CAT_DATA_DIR`. The database is fixed at `<data-dir>/game-cat.sqlite`; there is no separate `--db` path.                                                                                                                                      |
| Configuration     | `<data-dir>/config.json`, JSON, mode 0600 on POSIX, validated at startup. Precedence is CLI, then environment, then config file, then defaults.                                                                                                                                                                     |
| Steam Web API key | Stored in `config.json` or supplied by `GAME_CAT_STEAM_API_KEY`. It never enters SQLite, API responses, or logs. The browser onboarding writes it.                                                                                                                                                                  |
| Bind and port     | `127.0.0.1:4780` by default. Loopback only; no LAN mode and no authentication. A busy port exits non-zero; it never falls back to another port. `--port 0` is supported for the v4 wrapper.                                                                                                                         |
| Single instance   | An exclusive lock per data directory. A second process exits `ALREADY_RUNNING` and never touches the database.                                                                                                                                                                                                      |
| First run         | The server starts first, then the browser shows onboarding. Steam root and account are discovered; the user picks an account if ambiguous. The API key is required before the first Fetch.                                                                                                                          |
| Run scopes        | `library`, `ownership`, `metadata`, `all`. `all` is library, then ownership, then metadata.                                                                                                                                                                                                                         |
| Run modes         | `metadata` runs in **Fetch** or **Full Refresh** mode. `all` runs only Fetch. Fetch selects only sources with no usable current data (never attempted, `error`, or `stale`); it skips `ok`, `unavailable`, and settled misses. Full Refresh re-requests all three sources for an explicit `appIds` selection.       |
| Triggers          | An automatic `all` + Fetch on startup, and the same run from the primary UI action. Full Refresh is only available for selected Games. No scheduler, periodic job, or automatic Full Refresh.                                                                                                                       |
| Logging           | Pino. Human-readable on a TTY, JSON otherwise, plus a rotating `<data-dir>/logs/game-cat.log` (10 MB, 3 files). The key and `AccountName` are always redacted.                                                                                                                                                      |
| Lifecycle         | Foreground process. Closing the terminal stops it. SIGINT, SIGTERM, and SIGHUP trigger a graceful shutdown; no daemon, service, or auto-start in v1.                                                                                                                                                                |
| v4 wrapper        | The server is startable as a library, with option and environment overrides, `port: 0`, a readiness signal, a graceful stop, an injectable log sink, and a replaceable secret store. The wrapper may change packaging, windowing, keychain storage, and update delivery, not this contract's data or run semantics. |

## 2. Install and start

### 2.1 Supported install

```sh
npm install -g github:fran2889/game-cat#v1.0.0
game-cat
```

- The git install runs the package's `prepare` build (server and frontend) and installs the
  `game-cat` binary. It requires Git, Node 24 or newer, and npm.
- Pin a tag or commit. Do not install a floating `main` for daily use; an unreviewed commit can
  change the data contract.
- The first start creates the data directory, applies migrations, prints the URL, opens the
  browser, and shows onboarding or starts the automatic Fetch.
- `game-cat --help` lists the flags; `game-cat --version` prints the app version and bundled
  database schema version.
- The package is publish-ready (a `bin` entry, a `files` whitelist, and a `prepare` build), but
  publishing to the npm registry is not part of v1. A future publish changes only the install
  command.
- The GPL-3.0-only license applies. The GitHub repository is the corresponding source.

### 2.2 Contributor path

```sh
git clone https://github.com/fran2889/game-cat.git
cd game-cat
npm ci
npm run dev
```

- `npm run dev` runs the API and Vite together. Vite listens on 5173 and proxies `/api` to the API
  on 4780. The browser UI is `http://127.0.0.1:5173/`; the API URL is not opened directly in dev.
- `npm run build && npm start` runs the production-shaped single process, which serves the built
  frontend and the API on one port. `npm link` exposes the `game-cat` binary from the checkout.
- Contributors should use a separate data directory, for example
  `GAME_CAT_DATA_DIR="$PWD/.data" npm run dev`, so experiments do not touch the real library.

### 2.3 Runtime prerequisites

| Requirement   | Value                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Node          | 24 or newer (`engines.node: ">=24"`). The CLI checks `process.versions.node` and exits `NODE_VERSION` if older.                     |
| npm           | The npm shipped with Node 24, using the committed `package-lock.json`. No pnpm or yarn.                                             |
| Git           | Required for the supported GitHub install. Not required after installation.                                                         |
| Steam API key | A Steam Web API key, required before the first Fetch. Stored in `config.json` or `GAME_CAT_STEAM_API_KEY`; never in SQLite or logs. |
| Disk          | A writable local data directory. Network shares are unsupported because SQLite WAL needs shared-memory semantics.                   |
| Network       | Required for the first Fetch and for Full Refresh. Cached data remains browsable offline.                                           |

The app CI matrix is Node 24 and Node 26. The docs-only workflow is not the app runtime and may
stay on its current Node version until application code lands. Native modules in the app must
publish prebuilt binaries for supported platforms; otherwise the install needs a C/C++ toolchain.

## 3. Data directory and configuration

### 3.1 Location

| Platform | Default                                                            |
| -------- | ------------------------------------------------------------------ |
| Linux    | `$XDG_DATA_HOME/game-cat`, or `~/.local/share/game-cat` when unset |
| macOS    | `~/Library/Application Support/game-cat`                           |
| Windows  | `%LOCALAPPDATA%\game-cat`                                          |

- `--data-dir <path>` overrides the default for one process; `GAME_CAT_DATA_DIR` overrides it for
  an environment. The CLI wins over the environment.
- The path is resolved to an absolute path. `~` is expanded. A relative path is resolved against
  the current working directory and logged in absolute form at startup.
- The data directory is created with mode 0700 on POSIX if it does not exist.
- The data directory must not resolve inside the discovered Steam root. Starting with one is a
  hard error, `DATA_DIR_IN_STEAM`, because v1 never writes inside the Steam tree.
- There is no separate database path option. The database identity, account binding, and backups
  are tied to one data directory.
- Only one data directory per Steam account is supported in v1. Switching accounts requires a new
  data directory; see [§6.2](#62-account-selection).

### 3.2 Layout

```text
<data-dir>/
  config.json
  game-cat.sqlite
  game-cat.sqlite-wal
  game-cat.sqlite-shm
  game-cat.lock
  backups/
    game-cat.pre-v2-<epoch>.sqlite
  logs/
    game-cat.log
    game-cat.log.1
    game-cat.log.2
```

- `game-cat.sqlite` is the only database. `-wal` and `-shm` are SQLite's files; do not delete them
  while the process runs.
- `backups/` holds pre-migration copies. The migration runner keeps the last three and deletes
  older ones after a successful start.
- `logs/` holds the rotating log. The wrapper may redirect or disable the file sink; see
  [§10](#10-v4-wrapper-constraints).
- `game-cat.lock` is the single-instance lock. Its content is diagnostic; the OS lock is
  authoritative. Do not delete it while a process runs.
- The config file is the only place a secret may be stored. The database never contains the Steam
  Web API key.

### 3.3 Permissions

- On POSIX, the process sets `umask 0077` before creating the data directory and its files. The
  data directory and `logs/` and `backups/` are 0700; `config.json`, the database, WAL, SHM,
  backups, and logs are 0600.
- At startup, if `config.json` is group- or world-accessible on POSIX, the app attempts to tighten
  it to 0600. If that fails and the effective key comes from the file, startup exits
  `CONFIG_PERMISSIONS` rather than run with a readable secret. If the key comes from the
  environment, a warning is enough.
- On Windows, the per-user profile ACL is the security boundary. POSIX modes are not claimed
  there.
- The data directory and database must be on a local filesystem. WAL is not reliable on network
  shares.

### 3.4 `config.json`

All fields are optional. Defaults are applied after validation.

```json
{
  "steamApiKey": "REDACTED",
  "steamRoot": "/home/fran/.local/share/Steam",
  "steamId64": "76561198000000000",
  "port": 4780,
  "openBrowser": true,
  "logLevel": "info"
}
```

| Field         | Type    | Default  | Rules                                                                                             |
| ------------- | ------- | -------- | ------------------------------------------------------------------------------------------------- |
| `steamApiKey` | string  | none     | Non-empty when present. Secret. The environment variable wins when both are set.                  |
| `steamRoot`   | string  | auto     | Absolute path. When set, discovery uses it and does not silently fall back to another root.       |
| `steamId64`   | string  | auto     | 17-digit SteamID64. Pins the Account. Must match the bound account in an existing database.       |
| `port`        | integer | `4780`   | `0..65535`. `0` asks the OS for a port; the resolved URL is printed and available to the wrapper. |
| `openBrowser` | boolean | `true`   | Opening the browser is best effort; a failure is logged and is not a startup error.               |
| `logLevel`    | string  | `"info"` | `trace`, `debug`, `info`, `warn`, `error`, or `fatal`.                                            |

- Unknown keys are rejected with `CONFIG_INVALID` and the key path in the message, so a typo does
  not silently change behavior.
- The config file is parsed as strict JSON. A parse error is `CONFIG_INVALID`; the app does not
  rewrite or discard the file.
- `steamRoot` and `steamId64` are user overrides, not caches. When absent, discovery supplies
  them. The first account choice on a multi-account machine is persisted as `steamId64`.
- Do not store `dataDir`, a database path, or a bind host in the config. The data directory is
  resolved before the file is read, and the bind host is not configurable in v1.

### 3.5 Precedence

| Setting      | CLI           | Environment              | Config file   | Default             |
| ------------ | ------------- | ------------------------ | ------------- | ------------------- |
| Data dir     | `--data-dir`  | `GAME_CAT_DATA_DIR`      | —             | OS-standard path    |
| Steam key    | —             | `GAME_CAT_STEAM_API_KEY` | `steamApiKey` | unset               |
| Steam root   | —             | `GAME_CAT_STEAM_ROOT`    | `steamRoot`   | auto-discovery      |
| Account      | —             | `GAME_CAT_STEAM_ID64`    | `steamId64`   | most recent account |
| Port         | `--port`      | `GAME_CAT_PORT`          | `port`        | `4780`              |
| Open browser | `--no-open`   | `GAME_CAT_OPEN_BROWSER`  | `openBrowser` | `true`              |
| Log level    | `--log-level` | `GAME_CAT_LOG_LEVEL`     | `logLevel`    | `info`              |

- Boolean environment values accept `1`, `true`, `0`, and `false`, case-insensitively. Anything
  else is `CONFIG_INVALID`.
- The effective key source is reported as `file`, `env`, or `none`. When the environment wins, the
  settings UI disables editing the file value and explains why; editing the file would have no
  effect until the variable is removed.
- Invalid CLI, environment, or config values exit `CONFIG_INVALID` before binding a port or
  opening the database. They never create or migrate a database.

### 3.6 Secrets

- The Steam Web API key lives only in `config.json` (POSIX 0600) or
  `GAME_CAT_STEAM_API_KEY`. It is never written to SQLite, `refresh_runs`, logs, API responses,
  error details, stack traces, or backup files.
- Upstream URLs containing `key=` are redacted in logs. The access log omits query strings by
  default and redacts any parameter named `key`.
- The settings API is write-only for the key: it returns `steamApiKeySet` and
  `steamApiKeySource`, never the value or a prefix.
- `loginusers.vdf`'s `AccountName` is never exposed or logged. `SteamID64`, the derived account ID,
  and `PersonaName` may be shown.
- The database backups are database-only, so they never contain the key.

### 3.7 Configuration and account API (delta for #8)

The browser must be able to configure the app without editing files by hand. These endpoints are
loopback-only and require the request-trust checks in [§4.3](#43-request-trust).

| Method  | Path                  | Purpose                                                    |
| ------- | --------------------- | ---------------------------------------------------------- |
| `GET`   | `/api/config`         | Effective non-secret configuration and secret presence     |
| `PATCH` | `/api/config`         | Write non-secret settings and, optionally, the Web API key |
| `GET`   | `/api/steam/accounts` | Local Steam accounts for the first-run picker              |

`GET /api/config` returns `{ data: Config }`:

```json
{
  "data": {
    "dataDir": "/home/fran/.local/share/game-cat",
    "steamRoot": "/home/fran/.local/share/Steam",
    "steamId64": "76561198000000000",
    "port": 4780,
    "listeningUrl": "http://127.0.0.1:4780/",
    "openBrowser": true,
    "logLevel": "info",
    "steamApiKeySet": true,
    "steamApiKeySource": "file"
  }
}
```

- `port` is the configured value. `listeningUrl` is the effective one, which is how `--port 0`
  surfaces the OS-assigned port.
- `steamApiKeySource` is `file`, `env`, or `none`.
- `steamRoot` and `steamId64` are `null` when neither configured nor detected.
- `PATCH /api/config` accepts any subset of `steamApiKey`, `steamRoot`, `steamId64`, `port`,
  `openBrowser`, and `logLevel`. It validates, writes atomically through a same-directory temporary
  file with 0600 permissions, and returns `{ data: Config, meta: { restartRequired } }` with the
  same `Config` shape as `GET`. `restartRequired` is a boolean.
- `restartRequired` is `true` when `port` changes; the listening socket does not move until the
  next start. `logLevel` applies immediately. `openBrowser` applies to the next start. `steamRoot`
  and `steamId64` apply to the next discovery and run; an in-flight run keeps its snapshot.
- Writing `steamApiKey` when `GAME_CAT_STEAM_API_KEY` is set returns `422 VALIDATION_ERROR` with
  `fieldErrors.steamApiKey = "managed by GAME_CAT_STEAM_API_KEY"`; the file value would be
  ineffective.
- Changing `steamId64` when the database is bound to a different account returns
  `409 ACCOUNT_BOUND` with `details.boundSteamId64`. The write is rejected; the UI explains that
  switching accounts requires a new data directory.
- `GET /api/steam/accounts` returns
  `{ data: [{ steamId64, accountId, personaName }], pagination }` from `loginusers.vdf`. The list is
  always a single page: `page` is `1`, `pageSize` equals `totalItems`, and `totalPages` is `1`, or
  `0` for an empty list. It never returns `AccountName`. An empty array is a normal `no_account`
  state, not an error. A missing Steam root returns an empty array and the status endpoint reports
  `steam.state`.

The onboarding flow is: read `GET /api/status` and `GET /api/config`, choose or confirm the Steam
root and account, `PATCH /api/config` with the key, then `POST /api/refresh` with
`{ "scope": "all", "mode": "fetch" }`. The server does not start a run as a side effect of a
config write; the client starts it explicitly, so the onboarding screen can show its own
progress. A configured key on a later start triggers the automatic Fetch in [§7.8](#78-triggers).

## 4. Network contract

### 4.1 Binding and port

- The server binds `127.0.0.1` only. It never binds `0.0.0.0`, `::`, or a LAN interface in v1.
  There is no LAN or mobile-access mode, and there is no authentication.
- The default port is 4780. `--port`, `GAME_CAT_PORT`, and `config.port` override it. The value
  must be an integer in `0..65535`.
- `--port 0` asks the OS for a free port. The resolved URL is printed, returned by the programmatic
  start API, and exposed as `listeningUrl` in `GET /api/config`.
- If the port is already in use, the process exits non-zero with `PORT_IN_USE` and a message naming
  the override. It never tries the next port silently, because a moving URL breaks bookmarks, the
  v4 wrapper, and multi-tab use.
- The printed URL is `http://127.0.0.1:<port>/`. The UI and the wrapper use that origin. Requests
  with a `Host` of `localhost:<port>` are accepted when `localhost` resolves to loopback; other
  hosts are rejected.
- No TLS. Loopback is the trust boundary. Do not enable a proxy `trust proxy` setting or honor
  `X-Forwarded-*` headers.

### 4.2 Single instance

- Before opening the database, the process takes an exclusive OS lock on
  `<data-dir>/game-cat.lock`.
- The lock file contains the PID and start time for diagnostics. The OS lock, not the file
  content, decides ownership; a crash releases it automatically.
- If the lock is held, the process exits `ALREADY_RUNNING` with the owning PID and the data
  directory. It does not open the database, migrate, or delete the lock.
- If the file exists but no lock is held, it is stale. The process acquires the lock and overwrites
  the diagnostic content.
- Two processes with different data directories may run, but they need different ports.

### 4.3 Request trust

A localhost service with a secret store is reachable by any web page the browser loads. The
following checks are part of the contract, not optional hardening:

- Reject a request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` with
  `403 HOST_NOT_ALLOWED`.
- For `POST`, `PATCH`, and `DELETE`, when `Origin` is present it must match the server's origin;
  otherwise reject with `403 ORIGIN_NOT_ALLOWED`. Requests from `curl` without an `Origin` are
  allowed because they are not browser cross-origin requests.
- Require `Content-Type: application/json` for JSON bodies. A non-JSON POST or PATCH is
  `415 UNSUPPORTED_MEDIA_TYPE`; a form-encoded cross-site write never succeeds.
- CORS is same-origin only. No `Access-Control-Allow-Origin: *` and no cross-origin credentials.
- Serve HTML with `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`. The exact CSP belongs to the UI
  section; it must not require inline script.
- The config endpoints in [§3.7](#37-configuration-and-account-api-delta-for-8) are subject to all
  of these checks. They write a secret and are the highest-value target.

## 5. Startup sequence

### 5.1 Order

1. Check the Node major version. Exit `NODE_VERSION` when it is below 24, before any other work.
2. Parse CLI flags and environment. Resolve the data directory. Read and validate `config.json`;
   a missing file uses defaults. Exit `CONFIG_INVALID` on failure.
3. Discover the Steam root and accounts, read-only. This is not fatal when Steam is missing or has
   no account; `/api/status` reports `not_found` or `no_account`. Exit `DATA_DIR_IN_STEAM` if the
   resolved data directory is inside the discovered root. This check runs before the data directory
   is created, so a bad path never writes into the Steam tree.
4. Create the data directory and subdirectories with the permissions in [§3.3](#33-permissions).
   Exit `DATA_DIR_NOT_WRITABLE` if that fails.
5. Acquire the single-instance lock. Exit `ALREADY_RUNNING` if held. Any later startup failure
   releases the lock before exit.
6. Open the log sink. If the file cannot be opened, fall back to stderr and log a warning; logging
   never blocks startup.
7. Open SQLite and apply the connection pragmas in the data-model contract. Inspect the schema and
   run migrations with the pre-migration backup. Exit `DB_UNRECOGNIZED`, `DB_SCHEMA_TOO_NEW`, or
   `DB_MIGRATION_FAILED` as appropriate.
8. When an account is selected, compare it with `account_state.steam_id64`; exit
   `DB_ACCOUNT_MISMATCH` if they differ.
9. Reconcile interrupted runs ([§5.3](#53-interrupted-and-stale-runs)).
10. Bind `127.0.0.1:<port>`. Exit `PORT_IN_USE` if the bind fails.
11. Log the startup line and print the human URL. Open the browser unless `--no-open` is set, the
    config disables it, the environment is headless, or the open command fails.
12. If a Steam Web API key is configured, start the automatic `all` + Fetch run. If no key is
    configured, wait for onboarding. The run appears in `status.activeRefresh`.

The server is ready when the socket is listening and `GET /api/status` returns 200. The startup
line is the human-readable readiness signal; the programmatic API also resolves with
`{ url, port, close }`.

### 5.2 Startup failures

Startup failures exit non-zero and write a structured log event with the code. The v4 wrapper
reads the code from the event; it must not parse the human line.

| Code                    | Cause                                                                       |
| ----------------------- | --------------------------------------------------------------------------- |
| `NODE_VERSION`          | Node is older than 24.                                                      |
| `CONFIG_INVALID`        | Invalid JSON, unknown key, invalid value, or bad environment value.         |
| `CONFIG_PERMISSIONS`    | The file key is group/world-readable and cannot be tightened.               |
| `DATA_DIR_NOT_WRITABLE` | The data directory or a required subdirectory cannot be created or written. |
| `DATA_DIR_IN_STEAM`     | The data directory resolves inside the Steam root.                          |
| `ALREADY_RUNNING`       | Another process holds the data directory lock.                              |
| `DB_UNRECOGNIZED`       | The database has no `schema_migrations` table but has user tables.          |
| `DB_SCHEMA_TOO_NEW`     | The database schema is newer than the bundled app.                          |
| `DB_MIGRATION_FAILED`   | A migration failed; the previous schema and backup remain.                  |
| `DB_ACCOUNT_MISMATCH`   | The selected SteamID64 differs from the bound account.                      |
| `PORT_IN_USE`           | The configured port cannot be bound.                                        |
| `INTERNAL_STARTUP`      | An unexpected error before the server is ready.                             |

CLI usage errors exit 2 before any of the above. Clean shutdown exits 0. The exact numeric code
for runtime failures is 1; the string code is the contract, not the number.

### 5.3 Interrupted and stale runs

After migrations and the account guard, before binding:

- Every `queued` or `running` row in `refresh_runs` becomes `failed` with
  `error_code = "INTERRUPTED"` and `finished_at` set to `stats_json.lastProgressAt` when present,
  otherwise the reconciliation time.
- No per-Game or per-source data is rolled back. Each completed Game/source was committed in its own
  short transaction; only the run record is marked.
- `done` is advisory and may lag by up to 24 items because progress is persisted at most every 25
  items. The source-named tables are authoritative for what has been fetched.
- A graceful shutdown marks the active run immediately; a hard kill or power loss is reconciled on
  the next start. No run is auto-resumed; the next Fetch recomputes pending work, and a Full
  Refresh must be requested again.

## 6. First run and account selection

### 6.1 Steam detection states

The server always starts, even when Steam is absent. `/api/status` uses `steam.state` to describe
what the UI should show.

| Situation                                                     | `steam.state` | Behavior                                                                                                        |
| ------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| Steam root found, one account                                 | `ready`       | Use that account.                                                                                               |
| Steam root found, multiple accounts, pinned account present   | `ready`       | Use the pinned account.                                                                                         |
| Steam root found, pinned account absent from `loginusers.vdf` | `no_account`  | Report `no_account`; do not silently pick another account.                                                      |
| Steam root found, multiple accounts, no pin                   | `ready`       | Use `MostRecent` when exactly one account has it; if ambiguous, use the newest `Timestamp` and show the picker. |
| Steam root found, no account                                  | `no_account`  | Explain that Steam must be started and logged in once. No account-scoped run writes.                            |
| Steam root not found                                          | `not_found`   | Explain how to install or start Steam, or set `steamRoot`. The server stays up; cached data remains browsable.  |
| Discovery error                                               | `error`       | Show the error; no account-scoped run writes.                                                                   |

The first-run UI shows the discovered root and account, with an override for each. The account
picker is populated by `GET /api/steam/accounts`; it never displays `AccountName`. The chosen
SteamID64 is persisted with `PATCH /api/config`.

A configured `steamRoot` that does not exist is reported as `not_found` or `error`, not replaced
by auto-discovery. A configured `steamId64` that is absent from the local accounts is
`no_account`. Auto-discovery follows the local-library research note; this section does not
duplicate its path table or discovery order.

### 6.2 Account selection

- The selection order is: configured `steamId64`; the single local account; the unique
  `MostRecent` account; otherwise the newest `Timestamp` with a visible warning and the picker.
- The selected SteamID64 is written to `config.json` when the user confirms it. The UI keeps the
  choice visible in settings.
- The database binds to a SteamID64 on the first `library`, `ownership`, or `all` run that writes.
  A `metadata` run does not bind an account.
- If the selected account differs from `account_state.steam_id64`, startup exits
  `DB_ACCOUNT_MISMATCH` and a run fails with `ACCOUNT_MISMATCH`; neither writes or deletes data.
  Switching accounts requires a new data directory. The settings UI states this and does not offer
  an in-place reset.
- `steamRoot` may change without a new data directory, but the selected account must still match
  the bound one.

### 6.3 Steam Web API key

- The key is required. There is no deferred, optional-key, or local-only onboarding in v1. Without
  it the Library may be incomplete, and the UI must not imply a full roster.
- The onboarding form writes the key with `PATCH /api/config`. The server validates that it is
  non-empty and that no environment override is active; it does not verify the key with an
  upstream call at save time.
- The first run verifies the key. A `401` or `403` sets `ownership.state = invalid_key`, keeps
  cached data, and returns a message that lets the user correct the key. A missing key is
  `not_configured`; a rate limit is `rate_limited` with the backoff deadline.
- The key never travels to the browser after it is saved. The form is write-only.

### 6.4 First Fetch

- After the key is saved, the onboarding UI calls `POST /api/refresh` with
  `{ "scope": "all", "mode": "fetch" }`.
- The run scans local Steam files, fetches the ownership roster, then fetches every missing
  metadata source. On a fresh database every Game and source is missing, so the first Fetch is
  effectively a full metadata fill.
- If Steam is missing or has no account, the run still scans what it can and finishes `partial`
  with the relevant source state; metadata is fetched for any Games already known. It never
  claims a complete Library.
- Closing the onboarding before saving the key does not start a run. The next start shows
  onboarding again.
- The automatic startup Fetch is skipped while no key is configured. It is the same run once a key
  is present; see [§7.8](#78-triggers).

## 7. Run model: Fetch and Full Refresh

### 7.1 Scopes and modes

A run has a scope and, for metadata, a mode.

| Scope       | Mode    | Behavior                                                                         |
| ----------- | ------- | -------------------------------------------------------------------------------- |
| `library`   | absent  | Re-read local Steam files. Always a full read; there is no missing-only variant. |
| `ownership` | absent  | One `GetOwnedGames` request. Always full.                                        |
| `metadata`  | `fetch` | Fill gaps: select only `(Game, source)` pairs with no usable current data.       |
| `metadata`  | `full`  | Re-request all three metadata sources for an explicit `appIds` selection.        |
| `all`       | `fetch` | `library`, then `ownership`, then `metadata` in Fetch mode.                      |

`all` with `full` is invalid. `library` and `ownership` reject a mode. `metadata` requires a
mode. `appIds` is valid only with `metadata` + `full`; it is rejected with `fetch`, `all`,
`library`, and `ownership`. This keeps the expensive full-library re-fetch from being an accidental
one-click action.

### 7.2 Fetch selection

Fetch selects work per source, not per Game. The three sources are SteamSpy (`tags`), storefront
(`store`), and Steam reviews (`reviews`). A Game can need none, one, two, or all three.

A source is **pending** for a Game when:

| Stored state                                                                  | Pending? |
| ----------------------------------------------------------------------------- | -------- |
| No row for that source                                                        | yes      |
| `missing` with `*_fetched_at IS NULL` (never attempted)                       | yes      |
| `missing` with `*_fetched_at` set (settled miss, for example a SteamSpy miss) | no       |
| `error`                                                                       | yes      |
| `stale` (the last attempt failed and last-known-good data is served)          | yes      |
| `ok`                                                                          | no       |
| `unavailable` (storefront's settled delisted/region-blocked answer)           | no       |

- Fetch skips a source whose `source_state.retry_after_at` is in the future. The skipped work stays
  pending; the run records it and finishes `partial`.
- Fetch runs across the whole Library. It does not take `appIds`; a narrowed retry is a Full
  Refresh of the affected Games.
- The selection is computed at the start of the metadata phase, so an `all` run sees Games added or
  removed by its library and ownership phases.
- A Fetch with no pending work creates a `succeeded` run with `total: 0`, makes no upstream
  requests, and lets the UI say "up to date".
- Fetch is completion-based, not age-based. It is not a TTL: a settled miss is not retried forever,
  and a `stale` or `error` source is retried without waiting a week.

### 7.3 Full Refresh selection

- `appIds` is required: 1 to 5,000 unique positive App IDs, normalized to ascending order and
  stored in `refresh_runs.app_ids_json`.
- Every selected Game is fetched from all three sources, even when the stored value is `ok`.
  `unavailable` is also re-requested, because storefront availability can change.
- There is no per-Game skip. Only a source-wide `retry_after_at` can skip a source; the run then
  finishes `partial` and the UI can retry.
- A selected App ID that no longer exists is skipped and counted in `stats_json`; the run finishes
  `partial` if any were missing.
- Full Refresh is only for selected Games. There is no global "refresh everything" action. The UI
  disables the action above 5,000 selected Games and explains the limit rather than silently
  truncating.

### 7.4 Per-source execution

- SteamSpy is independent and serial; its request ceiling is the one in the metadata research
  contract.
- Storefront and Steam reviews share `store.steampowered.com` and its single rate budget. They are
  serialized against that host, never run concurrently, and share a pause on `429`, `403`, or a
  block challenge.
- The store and review passes use the response handling in the #4 rule grammar and the metadata
  research contract. A source-wide failure stops that source for the documented backoff, updates
  `source_state`, and does not stop the other sources.
- Per-Game and per-source rows are committed as work completes. The run record's progress is
  updated at most every 25 items to avoid write amplification. No transaction spans the run.
- A per-Game failure is recorded on that source's row and counted. A source failure makes the run
  `partial`, not `failed`.
- Metadata runs do not bind an account. On an unbound database they store `steam_id64 = NULL`; on a
  bound database they record the bound SteamID64 for history.

### 7.5 Run record and progress

`refresh_runs` keeps its existing columns and adds one:

```sql
mode TEXT CHECK (mode IN ('fetch', 'full') OR mode IS NULL)
```

The scope check becomes `('library', 'ownership', 'metadata', 'all')`. A combined check
enforces the combinations:

```sql
CHECK (
    (scope IN ('library', 'ownership') AND mode IS NULL AND app_ids_json IS NULL)
    OR (scope = 'all' AND mode = 'fetch' AND app_ids_json IS NULL)
    OR (scope = 'metadata' AND mode = 'fetch' AND app_ids_json IS NULL)
    OR (scope = 'metadata' AND mode = 'full' AND app_ids_json IS NOT NULL)
)
```

- `mode` is `NULL` for `library` and `ownership`, `fetch` or `full` for `metadata`, and `fetch` for
  `all`.
- `app_ids_json` is the explicit, normalized selection for `metadata` + `full`; it is `NULL` for
  every other combination. Fetch does not store the computed pending set; the next Fetch
  recomputes it from the source tables.
- `total` and `done` count **Games**, not source requests. For Fetch, a Game is counted once if it
  has at least one pending source; it is done when all of its pending sources have been attempted
  or skipped by backoff.
  For Full Refresh, `total` is the selection size and a Game is done when all three sources have
  been attempted or skipped by backoff. For `all`, `total` and `done` describe the metadata phase; library and ownership
  progress is visible through `status.library` and the run log. `total` may be `null` while the
  selection is being computed.
- `stats_json` holds small, non-secret counters: `sources.<steamspy|storefront|steam_reviews>`
  with `candidates`, `done`, `failed`, and `skipped`, plus `lastProgressAt`. `lastProgressAt` is
  the timestamp used for an interrupted run's `finished_at`.
- `RefreshRun` gains `mode` and a read-only `stats` object with the same per-source counters. The
  raw `stats_json` is not returned wholesale; only the whitelisted counters are.
- `done` is advisory and monotonic. It may lag the committed per-source rows by up to 24 items.
- `status.activeRefresh` and `status.lastRefresh` use the same shape, so the UI can show the mode
  and per-source progress.

### 7.6 Deduplication and concurrency

- v1 has one refresh worker and no queue. At most one run is `queued` or `running`.
- The deduplication identity is `scope`, `mode` (including `NULL`), and the normalized `appIds`
  selection (including `NULL`). An identical running request returns `202` with the existing
  `RefreshRun` and `meta.deduplicated: true`.
- Any other running run returns `409 REFRESH_IN_PROGRESS` with
  `details: { runId, scope, mode }`.
- The startup Fetch and a user's Fetch deduplicate because both are `all` + `fetch` with no
  `appIds`.
- A Fetch and a Full Refresh are different runs. Starting one while the other runs returns `409`;
  the UI shows the active run and disables the other action until it finishes.
- A repeated request after a run finishes starts a new run. There is no result cache.

### 7.7 Failure, interruption, and recovery

| Terminal status | Meaning                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `succeeded`     | All selected work was attempted and no failure or skip was recorded. This includes a zero-item Fetch.                                                  |
| `partial`       | The run finished, but some per-Game/source work failed, a source was skipped by backoff, selected Games were missing, or ownership was not configured. |
| `failed`        | The run did not finish: interruption, account mismatch, database failure, or an internal fatal error.                                                  |

- A source failure is `partial`, not `failed`.
- Interruption is `failed` with `error_code = "INTERRUPTED"`. Already-committed per-Game and
  per-source rows remain. The next Fetch recomputes pending work and resumes naturally.
- A Full Refresh is not auto-resumed. Its selection remains in history; the user can run it again.
- WAL plus short transactions preserve completed work across a process kill. A power loss can lose
  the last uncommitted transaction; that Game/source simply remains pending.
- On graceful shutdown the active run is marked immediately. On a hard kill the next start
  reconciles it in [§5.3](#53-interrupted-and-stale-runs).
- `failed` never hides Games or invalidates their data. The Library remains browsable; the status
  and refresh-errors view explain what is missing.

### 7.8 Triggers

- **Startup:** after listening, if a key is configured, start one `all` + Fetch. If no key is
  configured, start nothing and wait for onboarding. The startup Fetch is also the recovery for an
  interrupted run and the way new Games and failed sources are picked up.
- **Primary UI action:** Fetch. It sends `{ "scope": "all", "mode": "fetch" }`, the same run as
  startup. This updates local installs/playtime, ownership, and missing metadata in one action.
- **Selection action:** Refresh selected sends
  `{ "scope": "metadata", "mode": "full", "appIds": [...] }`. It is the only full re-fetch and is
  never triggered automatically.
- **Refresh-errors view:** a Fetch action retries all gaps. To force a re-fetch of affected Games, the
  user selects them and uses Refresh selected.
- There is no timer, periodic job, watch loop, cron, or background scheduler in v1. Closing and
  reopening the app is the only automatic retry. No Full Refresh is ever automatic.
- A startup Fetch with no pending work is a cheap zero-item run; it does not call upstream
  sources.

### 7.9 API delta for #8

`POST /api/refresh` keeps its path and gains a required `mode` for metadata scopes:

```json
{ "scope": "all", "mode": "fetch" }
```

```json
{ "scope": "metadata", "mode": "fetch" }
```

```json
{ "scope": "metadata", "mode": "full", "appIds": [10, 20, 30] }
```

```json
{ "scope": "library" }
```

```json
{ "scope": "ownership" }
```

Validation:

| Request                                               | Result                                                    |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `metadata` or `all` without `mode`                    | `422 VALIDATION_ERROR` (`fieldErrors.mode`)               |
| `metadata` + `full` without `appIds`                  | `422 VALIDATION_ERROR` (`fieldErrors.appIds`)             |
| `metadata` + `fetch` with `appIds`                    | `422 VALIDATION_ERROR` (`fieldErrors.appIds`)             |
| `all` + `full`                                        | `422 VALIDATION_ERROR` (`fieldErrors.mode`)               |
| `library` or `ownership` with `mode`                  | `422 VALIDATION_ERROR` (`fieldErrors.mode`)               |
| `appIds` empty, duplicate, non-integer, or over 5,000 | `422 VALIDATION_ERROR`                                    |
| Identical run already running                         | `202` with the existing run and `meta.deduplicated: true` |
| A different run already running                       | `409 REFRESH_IN_PROGRESS`                                 |

The body size limit remains 256 KiB. The `RefreshRun` shape gains `mode` and `stats`. The status
endpoints inherit the new fields. The API error table gains `ACCOUNT_BOUND` for the config endpoint
and `HOST_NOT_ALLOWED` / `ORIGIN_NOT_ALLOWED` for request-trust failures.

## 8. Logging

- The logger is pino. The default level is `info`; `--log-level`, `GAME_CAT_LOG_LEVEL`, and
  `logLevel` override it. `debug` adds per-Game upstream calls; `trace` is for local development.
- Every start writes to stderr and to `<data-dir>/logs/game-cat.log`. On a TTY, stderr is
  human-readable; otherwise it is JSON lines. The file is always JSON lines.
- The file rotates at 10 MB, keeping `game-cat.log`, `.1`, and `.2` (three files total). Rotation
  is in-process; no external logrotate is required. If the file cannot be opened, the app logs to
  stderr and continues.
- The startup line includes the app version, bundled schema version, Node version, data directory,
  effective port and URL, log level, and log file path. It never includes the key.
- Access logs include method, path without the query string, status, duration, and `requestId`.
  Query parameters named `key` are redacted. Upstream request logs redact the key and omit raw
  response bodies.
- Lifecycle events at `info`: start, ready, config change (redacted), run start, run finish with
  counts, source start/finish/failure, migration and backup, shutdown. Per-Game work is `debug`.
- The following are never logged: the Steam Web API key, `Authorization` or cookie headers,
  `AccountName`, raw SteamSpy/store/review payloads, license blobs, and launch options.
- `requestId` is a per-request identifier included in error responses and access logs. The error
  envelope's `requestId` must match the log line.
- The log file is a local diagnostic, not a telemetry channel. Nothing is sent off the machine.

## 9. Process lifecycle

- `game-cat` runs in the foreground. It does not daemonize, fork into the background, or install a
  service. Closing the terminal stops the server; the browser tab then shows a disconnected state.
- On POSIX, SIGINT, SIGTERM, and SIGHUP begin a graceful shutdown; on Windows, Ctrl+C and the
  console-close event do the same. The sequence is:
  1. stop accepting new connections;
  2. abort in-flight upstream requests;
  3. let the current short database transaction finish;
  4. mark the active run `failed` with `INTERRUPTED`, or finish a run that is already complete;
  5. close SQLite, release the lock, and exit 0.
- The graceful budget is 5 seconds: if cleanup has not finished by then, the process logs a warning
  and keeps waiting. At 10 seconds it exits non-zero. A second signal during shutdown exits
  immediately.
- A hard kill (`SIGKILL`, crash, power loss) cannot run cleanup. SQLite WAL keeps committed data
  safe; the next start marks the stale run `INTERRUPTED` and the next Fetch resumes pending work.
- A terminal close is a normal stop in v1. Users who want the server to outlive the terminal can
  use `nohup` or a systemd user unit, but both are unsupported: the startup URL, logs, restarts,
  and updates are then the user's responsibility. The v4 wrapper replaces this pattern.
- The server refuses to start a second process on the same data directory rather than sharing
  SQLite between processes. Two different data directories are independent.

## 10. v4 wrapper constraints

The v4 desktop wrapper may change packaging, the window, key storage, auto-update, and process
supervision. It must preserve the following:

1. **Library start.** The server can be started programmatically through a library entry such as
   `createServer(options)` / `startServer(options)`, not only through the CLI. The CLI is a thin
   wrapper over that entry.
2. **Option and environment overrides.** Data directory, config values, port, browser opening, and
   log level are settable through options and the documented environment variables. No path is
   hard-coded to the developer's home directory.
3. **Ephemeral port.** `port: 0` works, and the resolved URL is returned to the caller and emitted
   on the readiness event/stdout. The wrapper does not need to guess a port or scrape a log line.
4. **Loopback binding.** The default and supported bind is loopback only. The wrapper must not
   expose the server on a LAN interface.
5. **Graceful stop.** SIGTERM, or a programmatic `close()`, performs the shutdown in
   [§9](#9-process-lifecycle) and resolves only after SQLite is closed. Startup failures exit
   non-zero with a structured code.
6. **No terminal assumptions.** The server never prompts on stdin and never requires a TTY or a
   browser. `openBrowser: false` is honored.
7. **Injectable logging.** The log sink can be a file, a stream, or both. The wrapper can capture
   the stream and show it in a diagnostics view; the key remains redacted.
8. **Replaceable secret store.** Reading and writing the Steam Web API key goes through an
   interface. v1's implementation uses `config.json`; v4 may use the OS keychain. The refresh code
   and the API never depend on the file layout.
9. **Single instance.** The wrapper must surface `ALREADY_RUNNING` and the owning PID. It must not
   delete the lock, bypass it, or run two servers against one data directory.
10. **Readiness signal.** `GET /api/status` returns 200 when the server is ready, and the
    programmatic start resolves with the URL. The wrapper waits for one of these before showing
    the window.

The wrapper may embed the server in-process or spawn the CLI; both must work. The wrapper must pass
`openBrowser: false` and should use `port: 0` unless it needs a stable origin. It must not change
the data directory layout, account binding, run semantics, API shape, or the "never write inside
the Steam tree" rule. The browser UI remains the same; the wrapper can load the loopback URL in a
webview.

## 11. Deltas for #8

| Area              | Delta                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Glossary          | Add **Fetch** and **Full Refresh**; clarify that **Refresh** is the umbrella and its metadata phase has two modes.                                                                                                                                                                                                      |
| Data model (§4)   | Add `refresh_runs.mode`; change the scope check to `metadata`; add the combined scope/mode/selection check; widen the deduplication identity to scope + mode + normalized selection; keep `stats_json` counters.                                                                                                        |
| HTTP API (§5)     | Add `mode` to `POST /api/refresh`; add `mode`/`stats` to `RefreshRun`; add the config and account endpoints, including `restartRequired` on config `PATCH` and `data`/`pagination` on the account list; add `details.mode` to `409 REFRESH_IN_PROGRESS`; add `ACCOUNT_BOUND`, `HOST_NOT_ALLOWED`, `ORIGIN_NOT_ALLOWED`. |
| Status (§5.2)     | `activeRefresh` and `lastRefresh` carry `mode` and `stats`; the UI can show Fetch or Full Refresh progress per source.                                                                                                                                                                                                  |
| Security (§8)     | Loopback bind, Host/Origin checks, config file permissions, data-directory guard, and log redaction are normative.                                                                                                                                                                                                      |
| Rule grammar (#4) | The no-TTL rule and its acceptance check describe **Full Refresh**. Fetch is a completion-based selection policy, not a TTL.                                                                                                                                                                                            |
| UI (#6 and #8)    | The primary action is Fetch; Full Refresh is selection-scoped; the refresh-errors view offers Fetch retry and selects affected Games.                                                                                                                                                                                   |
| Startup and ops   | Link this contract from the v1 spec; add the startup codes in §5.2; the data-model contract's open question #7 is resolved here.                                                                                                                                                                                        |

The #4 no-TTL decision remains true for Full Refresh: every selected Game is fetched from every
source, even when recently fetched. Fetch does not violate it, because Fetch narrows the
`(Game, source)` selection before the fetch; it does not skip work inside a Full Refresh
selection. #8 must state that distinction next to the #4 acceptance check.

## 12. Acceptance checks

### Install and startup

- [ ] `npm install -g github:fran2889/game-cat#<tag>` on Node 24 installs a `game-cat` binary;
      `game-cat --version` prints the app and schema versions.
- [ ] Starting on Node 22 exits non-zero with `NODE_VERSION`.
- [ ] The first start creates `config.json`, `game-cat.sqlite`, `game-cat.lock`, `backups/`, and
      `logs/` with the documented layout.
- [ ] On POSIX, the data directory is 0700 and `config.json`, the database, WAL, SHM, backups, and
      logs are 0600.
- [ ] `--data-dir` and `GAME_CAT_DATA_DIR` override the default; no file is created in the default
      directory.
- [ ] A data directory inside the Steam root exits `DATA_DIR_IN_STEAM`.
- [ ] An invalid config, unknown key, or invalid environment value exits `CONFIG_INVALID` before
      the port is bound and before the database is opened.
- [ ] `config.json` precedence is CLI over environment over file over defaults, tested for each
      setting.
- [ ] A key in the environment is reported as `env`; `PATCH /api/config` with a key returns
      `422 VALIDATION_ERROR` and does not write the file.
- [ ] Changing `steamId64` after binding returns `409 ACCOUNT_BOUND` and writes nothing.
- [ ] A known injected key appears in no database column, database backup, log line, or HTTP
      response; the config endpoint returns only presence and source.

### Network and instances

- [ ] The default listener is `127.0.0.1:4780`; it is not reachable from another host on the LAN.
- [ ] A busy port exits `PORT_IN_USE` and does not try another port.
- [ ] `--port 0` listens on an OS-assigned port, and the printed URL and `listeningUrl` match the
      actual port.
- [ ] A second process on the same data directory exits `ALREADY_RUNNING` with the owning PID and
      does not open the database.
- [ ] Two processes with different data directories and different ports run independently.
- [ ] A request with a non-loopback `Host` returns `403 HOST_NOT_ALLOWED`.
- [ ] A state-changing request with a foreign `Origin` returns `403 ORIGIN_NOT_ALLOWED` and writes
      no config.

### First run

- [ ] With no Steam installed, the server returns 200 for `GET /api/status`,
      `steam.state = "not_found"`, and stays up.
- [ ] With Steam installed and no account, `steam.state = "no_account"` and no account-scoped run
      writes.
- [ ] With multiple accounts and no pin, the picker is populated from `GET /api/steam/accounts`,
      `MostRecent` is the default, and the chosen SteamID64 persists across restart.
- [ ] A pinned account absent from `loginusers.vdf` reports `no_account` and does not silently pick
      another account.
- [ ] Saving the key from onboarding followed by `POST /api/refresh` with `scope: all, mode: fetch`
      starts the first Fetch.
- [ ] An invalid key produces `ownership.state = "invalid_key"`, keeps cached data, and the UI can
      replace the key.
- [ ] The account list never contains `AccountName`.
- [ ] `GET /api/steam/accounts` returns `data` and `pagination`; an empty list reports
      `totalItems: 0` and `totalPages: 0`.

### Run model

- [ ] A fresh Fetch selects all three sources for every Game and stores per-source statuses and
      timestamps.
- [ ] Fetch skips `ok`, `unavailable`, and settled `missing` sources; it selects never-attempted
      `missing`, `error`, and `stale` sources.
- [ ] A Game with `tags = ok` and `store = error` causes a Fetch to request only the store source
      (and reviews only if pending), proven by request counts or debug logs.
- [ ] A Full Refresh of selected Games requests all three sources for every selected Game, even
      when the stored values are `ok`.
- [ ] A Fetch with no pending work creates a `succeeded` run with `total: 0` and makes no upstream
      request.
- [ ] A Fetch has `appIds = null`; a Full Refresh stores the normalized selection; the combined
      scope/mode/selection check rejects every other combination.
- [ ] `metadata`/`all` without `mode`, `metadata` + `full` without `appIds`, `metadata` + `fetch`
      with `appIds`, `all` + `full`, and `library`/`ownership` with `mode` all return `422`.
- [ ] `appIds` with duplicates, non-integers, zero/negative values, or more than 5,000 entries
      returns `422`.
- [ ] An identical running request returns `202` with `meta.deduplicated: true`; a different run
      returns `409 REFRESH_IN_PROGRESS` with the run ID, scope, and mode.
- [ ] A source failure makes the run `partial`, not `failed`, and the other sources complete.
- [ ] A source in `retry_after_at` is skipped, the run is `partial`, and the skipped count is in
      `stats`; the source state shows the backoff.
- [ ] `total`/`done` count Games; `stats.sources` counts per-source candidates, done, failed, and
      skipped; `done` never decreases.

### Interruption and recovery

- [ ] `kill -9` during a Fetch leaves every completed Game/source row intact.
- [ ] After restart, the stale run is `failed` with `INTERRUPTED`; `finished_at` is the last
      progress time; no data is rolled back.
- [ ] The next Fetch requests only the still-pending sources; it does not re-request `ok` sources.
- [ ] A Full Refresh is not auto-started after an interruption; its selection remains in history.
- [ ] A graceful SIGTERM marks the run immediately and exits 0 within 5 seconds; cleanup still
      running at 10 seconds exits non-zero.
- [ ] A run that is `queued` but never started is marked `failed` with `INTERRUPTED` on the next
      start.

### Logging and lifecycle

- [ ] The log file is JSON lines and rotates at 10 MB, keeping three files.
- [ ] A TTY shows human-readable stderr; a non-TTY shows JSON.
- [ ] The access log omits or redacts query strings containing `key`; no `AccountName` appears.
- [ ] `--log-level`, `GAME_CAT_LOG_LEVEL`, and `logLevel` change the level.
- [ ] Closing the terminal stops the process; the data survives and the next start works.
- [ ] On POSIX, SIGINT, SIGTERM, and SIGHUP all follow the graceful shutdown path; on Windows,
      Ctrl+C and console close do the same.
- [ ] A hard kill is reconciled on the next start; committed data survives.

### v4 wrapper

- [ ] `createServer({ port: 0, openBrowser: false, logSink })` starts without a TTY or browser,
      returns the loopback URL, and serves `GET /api/status`.
- [ ] The programmatic start resolves only after the server is listening.
- [ ] `close()` or SIGTERM performs the same graceful shutdown and resolves after SQLite closes.
- [ ] A test secret store can replace `config.json` without changing the refresh logic or exposing
      the key through the API.
- [ ] The wrapper receives `ALREADY_RUNNING` with the owning PID and never deletes the lock.
- [ ] The wrapper can load the loopback URL in a webview and use the same UI as the browser.

## 13. Open questions and risks

- **Large selections.** Full Refresh is capped at 5,000 `appIds`, and v1 has no global full
  refresh. A 5k-20k Library cannot force-refresh everything in one run; the UI disables the action
  above the cap. Revisit with #1's large-library performance work.
- **Cross-platform testing.** The contract defines Linux, macOS, and Windows paths and permissions,
  but v1 is verified on Linux first. Windows lock semantics and macOS app-bundle paths need a pass
  before release.
- **Git install fragility.** The supported install runs `prepare` and installs dev dependencies
  from a Git checkout. If npm changes that behavior, or a user lacks Git, the fallback is a release
  tarball built by CI. Revisit before publishing to npm.
- **Native SQLite binaries.** A missing prebuild turns a simple install into a compiler
  requirement. The release checklist must cover the supported platforms.
- **WAL on network filesystems.** WAL is unsupported on network shares; the data directory must be
  local. There is no portable, reliable filesystem-type check, so this is documented rather than
  enforced.
- **Keychain in v4.** v1 stores the key in a 0600 file. The v4 wrapper should move it to the OS
  keychain behind the interface in [§10](#10-v4-wrapper-constraints); this is not a v1 requirement.
- **Per-Game error text.** The API exposes source-level `lastError` but not per-Game `*_error`. If
  the refresh-errors view needs per-Game messages, #8 must decide how to expose a safe subset.
- **Port 4780.** The default is arbitrary and configurable. A collision is an explicit error, not
  an automatic fallback, so users on a busy port must choose another one.
- **Browser auto-open.** Headless and remote sessions cannot open a browser. The URL is always
  printed, and the failure is non-fatal.
- **Steam root discovery.** Multiple native/Flatpak/Snap/portable roots are handled by the
  local-library contract; this section only defines the override and the visible states.
