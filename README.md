# game-cat

A better way to browse and filter a Steam library: a locally-run web app that reads local Steam data, adds metadata from SteamSpy, the storefront, and Steam reviews, and saves reusable Smart Collections.

Steam-only for now. Later phases add How Long To Beat times, writing Smart Collections back to Steam as Steam Collections, and a desktop wrapper.

## Status

Pre-implementation. The v1 contract is merged and authoritative:
[docs/specs/game-cat-v1.md](docs/specs/game-cat-v1.md).

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
