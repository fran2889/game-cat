# Add `@tabler/icons-react` for the shell icon set

## Status

Accepted (2026-11-21). Records [#88](https://github.com/fran2889/game-cat/issues/88). Amends
[ADR 0004](0004-libraries-over-boilerplate.md)'s dependency list and
[spec §1.5](../specs/game-cat-v1.md#15-architecture).

## Context

[ADR 0004](0004-libraries-over-boilerplate.md) says a library must delete more code than the
dependency surface it adds, and enumerates the runtime dependencies added by the
libraries-over-boilerplate effort. That test targets hand-written plumbing. The shell-chrome ticket
([#88](https://github.com/fran2889/game-cat/issues/88)) is presentation: it replaces the sidebar and
top-bar text/emoji glyphs with the prototype's icon set, and the prototype uses
`@tabler/icons-react` throughout.

Hand-drawing the same icons would add more code, drift from the prototype, and give each surface its
own icon vocabulary. The package is MIT, pure JavaScript, actively maintained, and has one
transitive dependency (`@tabler/icons`), so it meets ADR 0004's licence, portability, and
maintenance constraints. The delete-more-code test does not fit a presentation dependency that
replaces glyphs rather than plumbing.

## Decision

Add `@tabler/icons-react` 3.52.0, pinned exactly like the prototype, to `dependencies`. Import named
icons in the client only; the server, shared contract, and data layer do not depend on it. Decorative
icons carry `aria-hidden="true"`; controls keep a visible text label or an explicit accessible name.
The package is the single source of icon shapes for the shell, so a new glyph is an import rather
than another hand-written SVG.

## Consequences

- The runtime dependency list in [spec §1.5](../specs/game-cat-v1.md#15-architecture) and
  [ADR 0004](0004-libraries-over-boilerplate.md)'s consequences grows by one package.
- The icons tree-shake through named imports; only the icons the shell imports enter the bundle.
- ADR 0004's delete-more-code test is unchanged for plumbing. A future presentation library still
  needs its own decision, and this ADR is the precedent for judging one: prototype parity, a single
  source, a permissive licence, and no native code.
