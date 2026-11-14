# game-cat documentation standards

Review rules for specs, ADRs, and glossary changes. Mechanical checks live in `npm run check`;
this file covers the judgements a linter cannot make.

## Vocabulary

- `GLOSSARY.md` is canonical. Read it before naming anything.
- Add a glossary entry before a new domain term appears in a spec.
- Use the preferred terms: Metadata (not enrichment), Refresh (not sync), Account (not user or
  login), Genre and Storefront Category (not bare category), Steam Collection (not Steam
  category).
- A term's definition, its storage column, and its API field describe the same concept.
- Name a metadata table after its source: `steamspy_appdetails`, `storefront_appdetails`, or
  `steam_review_summaries`. Do not add a catch-all `game_enrichment` or `game_metadata` table.

## Specs

- Keep one source of truth per fact. Schema, SQL, prose, and JSON examples must agree on names,
  enum values, defaults, and nullability.
- Define every enum value in the table notes, not only in an acceptance check or example.
- Give every new table a `####` note and at least one acceptance check.
- Give every list response `data`, `pagination`, and optional `meta`.
- Use the single documented error shape for every error.
- Keep API fields camelCase and database columns snake_case. Do not reuse one field name for two
  shapes.
- Link to the research contracts; do not duplicate their content.
- Put every mechanically checkable rule in `npm run check`, not in prose.

## Review

- Review schema, SQL, prose, and examples as one contract. A contradiction between two is a hard
  finding, not an editorial nit.
- Treat a section explicitly marked as pending a named issue as deferred, not as a new
  contradiction. Verify the delta is internally consistent and the pending marker is accurate;
  contradictions with unmarked current sections remain hard.
- Flag a new term with no glossary entry.
- Flag a new enum value with no definition.
- Flag a new endpoint with no empty or degraded state.
- Flag a new table with no note or acceptance check.
