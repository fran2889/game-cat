# License game-cat under GPL-3.0-only

## Status

Accepted (2026-11-14).

## Context

Issue [#13](https://github.com/fran2889/game-cat/issues/13) asked for the license of this clean-slate
repository. The constraints were: no code reuse from the GPLv3 `steam-cat`, which stays reference
only; SteamSpy and storefront terms; and redistribution of fetched metadata and Cover Art. The
repository is public but docs-only, so the choice also settles how future code and the existing
specs and ADRs are licensed. The alternatives were MIT, Apache-2.0, GPLv3, and source-available.
MIT and Apache-2.0 would permit proprietary forks and would force a relicensing decision before any
`steam-cat` code could be reused. Source-available would make the project non-free software and
complicate outside contributions. Every planned dependency is permissive (MIT, or Apache-2.0 for
TypeScript), so copyleft imposes no compatibility problem.

Third-party terms remain unresolved: the [Steam metadata contract, #5](https://github.com/fran2889/game-cat/issues/5)
could retrieve no SteamSpy terms, and no Valve source grants redistribution of store metadata or
Cover Art. The license therefore cannot, and does not, cover that material; the runtime-only policy
below is a precaution against unresolved terms, not a legal conclusion.

## Decision

game-cat is licensed under the GNU General Public License, version 3 only, covering the entire
repository — application code, tooling, specs, ADRs, the glossary, and the README — identified as
`GPL-3.0-only` in SPDX terms, with exactly the terms distributed in [LICENSE](../../LICENSE) and no
"or any later version" clause and no separate documentation license. Because the project is
already GPLv3, reusing `steam-cat` code later would require no relicensing, while the clean-slate
destination still forbids copying until a deliberate decision says otherwise. The license covers
only original project material: Steam metadata, SteamSpy data, and Cover Art are fetched at
runtime and never redistributed with the project, so they remain subject to SteamSpy's and Valve's
unresolved terms and are outside the scope of this license.

## Consequences

- Distributing source or binaries, including a packaged desktop build, must comply with GPLv3:
  complete corresponding source, the license text, and no additional restrictions.
- No contribution process exists yet. Contributions, when accepted, will be inbound under GPLv3
  with no contributor license agreement planned, so relicensing to a later GPL version would
  require the consent of every contributor.
- The GPLv3-only choice keeps the option of reusing `steam-cat` code without relicensing, but any
  such reuse must still be a separate, explicit decision.
- Third-party dependency licenses and notices are preserved; all current dependencies are
  permissive and compatible with GPLv3.
- No SteamSpy data, store metadata, or Cover Art is committed or bundled. Test fixtures should use
  synthetic data, and any cache stays in the Account's data directory outside the repository.
