# game-cat

TypeScript end to end: a Fastify server and a React/Vite client in one Node process. Node 24 or newer.

- v1 contract: [docs/specs/game-cat-v1.md](docs/specs/game-cat-v1.md) is the single authoritative
  v1 specification. It was merged via [#8](https://github.com/fran2889/game-cat/issues/8) and retired
  the earlier data model and API, rule grammar, and run contract drafts.
- Layout: `src/server` (config, startup, HTTP), `src/client` (React shell and views),
  `src/shared` (wire types), `tests` (Vitest), `scripts` (dev/build).
- Commands: `npm run dev`, `npm test`, `npm run check`, `npm run build`, `npm start`.
  Use `GAME_CAT_DATA_DIR` to keep development data out of the OS data directory.
- ADRs: [docs/adr/](docs/adr/).
- Vocabulary: [GLOSSARY.md](GLOSSARY.md) is canonical.
- Research notes: `git show research/<slug>:docs/research/<slug>.md`; stable summaries in issues #2, #5, and #14.
- Tracker: GitHub issues. #1 is the map, #8 the merged v1 contract.
- Checks: `npm ci && npm run check && npm test`.
