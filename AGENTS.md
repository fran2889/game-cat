# game-cat

TypeScript end to end: a Fastify server and a React/Vite client in one Node process. Node 24 or newer.

- v1 contract: [docs/specs/game-cat-v1.md](docs/specs/game-cat-v1.md) is the single authoritative
  v1 specification. It was merged via [#8](https://github.com/fran2889/game-cat/issues/8) and retired
  the earlier data model and API, rule grammar, and run contract drafts.
- Layout: `src/server` (config, startup, HTTP), `src/client` (React shell and views),
  `src/shared` (wire types), `tests` (Vitest and Playwright), `scripts` (dev/build/package/perf
  checks).
- Commands: `npm run dev`, `npm test`, `npm run check`, `npm run build`, `npm start`,
  `npm run test:e2e`, `npm run test:package`, `npm run test:perf`. Use `GAME_CAT_DATA_DIR` to keep
  development data out of the OS data directory.
- Performance: `npm run test:perf` enforces the §10.5 budgets against fixed 20,000-Game and
  1,300-Game fixtures; see [docs/perf.md](docs/perf.md). It runs in the nightly/manual `perf`
  workflow, not on every pull request.
- Packaging: `bin`, `files`, and `prepare` are the supported Git-install path. `npm run test:package`
  packs, installs the tarball into a temporary prefix, and starts the installed binary.
- Lifecycle: `createServer()` is the library seam; `startServer()` adds SIGINT/SIGTERM/SIGHUP
  handling. `close()` stops accepting, aborts upstream work, marks an active run `INTERRUPTED`,
  closes SQLite, releases the lock, and only then resolves. Logs are JSONL in the data directory and
  human-readable on a TTY; the key and `AccountName` are never logged.
- Secret storage goes through `SecretStore`; v1 uses `config.json`, and a wrapper can inject another
  store without changing Refresh or the API.
- Checks: `npm ci && npm run check && npm test`; `npm run check` includes `npm run lint` (ESLint:
  no focused or skipped tests, and no real key, `AccountName`, or raw Steam user path). CI also
  builds on Node 24 and 26, runs E2E on Node 24 with Chromium, runs the package smoke test, and keeps
  performance in the nightly/manual workflow.
- Release evidence: [docs/release/v1-checklist.md](docs/release/v1-checklist.md) records the Linux
  results and the macOS/Windows and real-Steam gaps.
- ADRs: [docs/adr/](docs/adr/).
- Vocabulary: [GLOSSARY.md](GLOSSARY.md) is canonical.
- Research notes: `git show research/<slug>:docs/research/<slug>.md`; stable summaries in issues #2, #5, and #14.
- Tracker: GitHub issues. #1 is the map, #8 the merged v1 contract.
