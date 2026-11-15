# game-cat

A better way to browse and filter a Steam library: a locally-run web app that reads local Steam data, adds metadata from SteamSpy, the storefront, and Steam reviews, and saves reusable Smart Collections.

Steam-only for now. Later phases add How Long To Beat times, writing Smart Collections back to Steam as Steam Collections, and a desktop wrapper.

## Status

Early implementation. The v1 contract is merged and authoritative:
[docs/specs/game-cat-v1.md](docs/specs/game-cat-v1.md). The bootable server, configuration, data
directory, lock, logging, HTTP boundary, and React shell are in place; the SQLite schema, local
Steam scan, Metadata Refresh, and Smart Collection editor land in later slices.

## Development

Requires Node 24 or newer and npm with the committed lockfile.

```sh
npm ci
npm run dev        # API on 4780, Vite UI on http://127.0.0.1:5173/
npm test           # unit and HTTP integration tests
npm run check      # formatting, Markdown, links, and typecheck
npm run build      # server and static client in dist/
npm start          # production-shaped single process
npm run test:perf  # fixed 20,000-Game / 1,300-Game performance budgets
```

`test:perf` builds first, measures p50/p95, and exits non-zero on a missed budget. See
[docs/perf.md](docs/perf.md) for the fixture seeds, recorded results, and the reference runner.

Use a separate data directory while developing:

```sh
GAME_CAT_DATA_DIR="$PWD/.data" npm run dev
```

## Planning

- [GLOSSARY.md](GLOSSARY.md) - the project's vocabulary.
- [docs/specs/game-cat-v1.md](docs/specs/game-cat-v1.md) - the merged, authoritative v1 contract.
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
