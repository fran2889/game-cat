# Replace hand-rolled plumbing with libraries, keep domain logic hand-written

## Status

Accepted (2026-11-16). Records [#50](https://github.com/fran2889/game-cat/issues/50). Amends
[spec §1.5](../specs/game-cat-v1.md#15-architecture).

## Context

The server already used Fastify, `better-sqlite3`, and pino, but large parts of the internals were
written by hand: five near-duplicate query parsers, 100 prepared-statement call sites with
string-concatenated `WHERE`/`ORDER BY` clauses, a 1,130-line config/env/secret layer, a 121-line log
rotator, a 298-line pair of custom audit scripts, and a client with no component, data-fetching, or
form library (5,667 lines of TSX and 2,785 lines of CSS).

The maintenance problem is not that these exist, but that generic plumbing — "boilerplate" in this
ADR — was being maintained as product code: `parseInteger` appeared five times, `validationError`
appeared seven times, and the client re-encoded the server's rule validation in a separate module that
could drift.

[Spec §1.5](../specs/game-cat-v1.md#15-architecture) pinned the stack, so a policy decision was needed
before any ticket could be cut.

## Decision

Adopt established libraries for **generic plumbing** and keep **domain logic** hand-written. The
boundary is the test: if a library would own behaviour the [spec](../specs/game-cat-v1.md) describes
as product behaviour, it is out.

Constraints agreed for the whole effort:

- **The user-visible v1 contract is frozen.** Same HTTP API, SQLite schema, on-disk formats, rule
  semantics, log shape, and CLI surface, beyond flag spellings that a parser swap unavoidably renames.
  Internal integration points and module seams may move where a library swap justifies it.
- **No new native dependencies.** Native addons need a per-OS/architecture binary or a compiler at
  install time, which contradicts the portability goal. `better-sqlite3` is grandfathered because it
  is already present; replacing it with `node:sqlite` is a separate, optional decision.
- **Pure JavaScript, GPL-3.0-only compatible, actively maintained.** A library must delete more code
  than the dependency surface it adds.
- **One ticket at a time**, each merged to `main` green before the next starts, and each pinning the
  behaviour it replaces with tests before the swap.
- **Gates.** The testing decisions in [#50](https://github.com/fran2889/game-cat/issues/50) stand: one
  HTTP seam (`createServer()` plus `inject`), an unchanged shared contract suite, characterisation
  tests before each swap, the §10.5 budgets after the SQL strand, and Playwright plus axe for the UI
  strand. No new seam is introduced.

Per area:

- **HTTP boundary.** Fastify route schemas (JSON Schema, compiled by the ajv Fastify already bundles)
  for request validation and response serialisation. The domain rule validator stays shared code, not
  a library. Duplicated `parseInteger` / `validationError` / `asRecord` helpers are removed.
- **SQL.** Kysely for query construction over the existing `better-sqlite3` connection. Migrations
  stay hand-written: the `DB_UNRECOGNIZED` / `DB_SCHEMA_TOO_NEW` refusals, per-migration
  `BEGIN IMMEDIATE`, pre-migration `VACUUM INTO` backup, and backup pruning are product behaviour.
- **Refresh worker.** Unchanged: one in-process worker, no queue, scheduler, second writer, or
  separate process. Only the four repeated adapter timeouts become `AbortSignal.timeout()`. The
  1,830-line module is split by phase as a prefactor; no job library is adopted.
- **Client data layer.** TanStack Query for fetching, polling, and cache invalidation, replacing the
  23 repeated `fetch` wrappers and the hand-written 800 ms status poll.
- **Forms.** No form library around the Autosave editor: `AutosaveController` is an application state
  machine, not boilerplate. `@mantine/form` is permitted only in the save-button views. The real
  duplication is the client's mirror of the server rule validator, which is deleted.
- **UI.** Mantine for components and styling, sequenced last so the server strands land
  independently. The framework choice comes from the existing unmerged mockup evidence; that branch is
  evidence, not code to build on, and is not merged.
- **Small replacements.** `commander` for argument parsing and ESLint rules replacing the two custom
  audit scripts. Log rotation stays hand-written: `pino-roll` renames the active file (it writes
  `game-cat.1.log` and no stable `game-cat.log`), and `rotating-file-stream` v4 does not reproduce the
  documented `game-cat.log`, `.1`, `.2` set either. The filenames are part of the frozen contract, so
  the 121-line rotator is the smaller risk.

## Considered Options

- **zod instead of Fastify schemas.** Isomorphic and reusable in the client, but adds a runtime
  dependency to do work Fastify already does, and the shared rule validator — the part the client
  actually reuses — stays hand-written either way.
- **Drizzle instead of Kysely.** Closer to an ORM and carries a migration tool the project does not
  want; Kysely is a query builder only.
- **A durable queue (`bullmq`, `pg-boss`, `bree`).** Needs a broker or a second process, violates
  §1.5, and makes work resume across restarts — a user-visible change, not a refactor.
- **`p-queue` / `p-retry` inside the worker.** Legal in spirit but saves roughly 150 of 1,830 lines
  while adding dependencies; splitting the module by phase is the better lever.
- **A form library around the Autosave editor** (react-hook-form, TanStack Form, Formik, Conform).
  Would delete at most 10–20% of two views, and nothing from the Smart Collection editor, whose size
  is domain behaviour. Adopting one would create a second owner of dirty/valid state beside
  `AutosaveController`. `@mantine/form` is not in this class: it is confined to the save-button views.
- **`proper-lockfile` for the single-instance lock.** Rejected: its staleness is mtime-based, so a
  live but stalled process can have its lock stolen. §8.4 and AC-C12 require crash-released ownership
  and `ALREADY_RUNNING` carrying the owning PID, which the hand-written PID/start-time check provides.
- **MUI, Ant Design, or shadcn instead of Mantine.** Evaluated as framework mockups on the unmerged
  `prototype/v1-ui` branch (`docs/prototype/frameworks`, commit `e325912`); Mantine was preferred for
  its form and hooks packages and its complete component coverage without a styling runtime.

## Consequences

- §1.5 now names the libraries and the boundary. Tickets cite this ADR instead of re-arguing it.
- Five pure-JS runtime dependencies are added over the effort (`kysely`, `@tanstack/react-query`,
  `@mantine/core`, `@mantine/hooks`, `commander`), and a sixth (`@mantine/form`) if the UI strand
  lands, plus ESLint as a development dependency. No native additions.
- When [#63](https://github.com/fran2889/game-cat/issues/63) lands, `npm run check` gains ESLint and
  the two custom audit scripts become lint configuration; `audit:tests` and `audit:secrets` keep
  their current rules. Until then `README.md`, `AGENTS.md`, and §9.9 describe today's pipeline.
- The UI strand changes appearance, unlike the server strands.
  [§7.10](../specs/game-cat-v1.md#710-visual-reference) keeps the prototype's layout, flows, and
  states as the reference, not its component styling. The Playwright suite, the axe accessibility
  assertions, and the contract tests are the gate; the frozen contract is the API, not the pixels.
- The Refresh module's size is addressed by cohesion, not by a dependency. If a durable queue is ever
  wanted, it is a v2 product decision that supersedes this ADR.
