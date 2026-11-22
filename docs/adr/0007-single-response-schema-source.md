# One response schema source, with golden fixtures as the independent oracle

## Status

Accepted (2026-11-22). Records [#75](https://github.com/fran2889/game-cat/issues/75). Keeps the
`#75` decision ahead of [#72](https://github.com/fran2889/game-cat/issues/72).

## Context

API response shapes were described twice: `src/server/http/schemas.ts` for Fastify serialisation and
`tests/contract/schemas.json` for the contract suite. The two copies described the same objects, so
every API change had to be made twice, and a unit test existed only to prove the copies agreed.
Nothing proved either copy matched the documented examples. [#72](https://github.com/fran2889/game-cat/issues/72)
would add five more endpoints and make the duplication worse.

The contract suite also had to stay **independent**. Validating a response against a schema imported
from production proves only that the response agrees with its own serializer; it cannot catch a wrong
schema.

## Decision

- Response shapes are defined once in `src/shared/http-schemas.ts`. Fastify imports them for
  serialisation, and the contract suite imports the same objects for validation.
- Request, query, and body schemas stay in `src/server/http/schemas.ts`; they are not part of the
  response contract.
- Independence comes from data, not a second schema:
  - `tests/contract/golden.json` holds responses captured from the live HTTP boundary by
    `npm run contract:golden`. Only volatile values (timestamps, generated UUIDs, request IDs, the
    temporary data directory) are normalised to fixed placeholder values.
  - The contract suite compares every current response and status code against the fixture.
  - The fixture is also validated against the shared response schema.
  - A permanent test deliberately corrupts a copy of each response schema and proves the fixture is
    then rejected.
- The documented JSON examples in [the v1 spec](../specs/game-cat-v1.md) remain a second independent
  check: prose and schemas must still agree.
- Recapture goldens only for an intentional response change, review the diff, and commit the fixture
  with the code. Never recapture to make a failing schema pass.

## Considered options

- **Keep the duplication deliberately.** Rejected: it is ~700 lines of schema plus a comparison test,
  and #72 would add substantially more.
- **Generate both sources from one spec at build time.** Rejected: adds a generation step and
  generated diffs to every review for an internal, localhost-only API.
- **Use Vitest snapshots instead of committed golden fixtures.** Rejected: the same data, but the
  update path is a test-run flag rather than an explicit command whose output can be diffed and
  reviewed. The JSON fixture is also readable without running the suite.

## Consequences

- An API response change now requires a deliberate fixture recapture and a reviewable golden diff.
- Deliberately deleting a `GameSummary` property from the shared schema fails four contract tests
  across the spec examples and golden fixtures.
- [#72](https://github.com/fran2889/game-cat/issues/72) can attach the already-defined `status`,
  `config`, `steamAccounts`, and `refresh` response schemas without adding a second definition;
  `/api/rules/preview` reuses the Games list envelope.
- The implementation is +2,285 / -1,552 lines (net +733) before this record: it deletes the 749-line
  schema file and the 119-line comparison test, and adds a 1,040-line golden fixture and a 315-line
  contract harness.
