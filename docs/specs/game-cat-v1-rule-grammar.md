# game-cat v1: rule grammar and evaluator

Status: draft for [#4](https://github.com/fran2889/game-cat/issues/4), ready to fold into the
v1 spec ([#8](https://github.com/fran2889/game-cat/issues/8)).

This section defines the Rule grammar, the Field registry, the evaluator, and the validation
rules for game-cat v1. It also records the Steam review source and the `Metadata` terminology and
schema deltas that the review Field forces. The storage and HTTP contracts remain owned by
[#3](https://github.com/fran2889/game-cat/issues/3); this section only states the deltas.

Related contracts:

- [v1 data model and HTTP API](game-cat-v1-data-model-and-api.md)
- [Steam metadata sources](https://github.com/fran2889/game-cat/blob/research/metadata-sources/docs/research/metadata-sources.md)
- [Steam local library: file formats and discovery](https://github.com/fran2889/game-cat/blob/research/steam-local-library/docs/research/steam-local-library.md)
- [Steam dynamic collections: `filterSpec`](https://github.com/fran2889/game-cat/blob/research/steam-filterspec/docs/research/steam-filterspec.md)
- [GLOSSARY.md](../../GLOSSARY.md) is canonical for domain vocabulary.

The decisions below were settled on #4 on 2026-11-13.

## Contents

- [1. Decisions](#1-decisions)
- [2. Rule object](#2-rule-object)
- [3. Field registry](#3-field-registry)
- [4. Field semantics](#4-field-semantics)
- [5. Evaluation](#5-evaluation)
- [6. Missing and unknown values](#6-missing-and-unknown-values)
- [7. Validation](#7-validation)
- [8. Worked test cases](#8-worked-test-cases)
- [9. Steam review source](#9-steam-review-source)
- [10. Schema, API, and terminology delta](#10-schema-api-and-terminology-delta)
- [11. Acceptance checks for #8](#11-acceptance-checks-for-8)
- [12. Open questions](#12-open-questions)

## 1. Decisions

| Topic                     | Decision                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule shape                | A Rule is a Prefix, a Field, an Operator, and a Value. Prefixes are `AND`, `OR`, and `NOT`.                                                                                                             |
| Groups                    | Prefixes group globally, not by adjacency: all AND Rules must match, at least one OR Rule must match when any OR Rule exists, and no NOT Rule may match.                                                |
| Empty Rules               | An empty Rules array matches every Game.                                                                                                                                                                |
| Missing values            | Evaluation is two-valued. A comparison against a missing value is false. A matching NOT Rule vetoes; it does not assert the opposite.                                                                   |
| Matching                  | Text and enum values use the shared `name_key` normalization. `is` and `has` are exact after normalization; `contains` is a normalized substring. List values are not accepted for multi-valued Fields. |
| Numbers                   | Playtime, years, scores, and counts use `lt`, `lte`, `gt`, and `gte` only. No numeric `is`.                                                                                                             |
| Last Played               | A UTC date value (`YYYY-MM-DD`); no `is`, no relative windows, and no clock-dependent Field in v1.                                                                                                      |
| Steam Collection Field    | The value is a Steam Collection ID. Only static membership matches; dynamic and unknown IDs never match.                                                                                                |
| Game Field                | Field `game`, operator `in`, a list of 1-1000 unique positive App IDs. Unknown App IDs are allowed and never match.                                                                                     |
| Validation                | Field and Operator IDs are strict. Vocabulary values (Tag, Genre, Developer, and so on) are free text and may match nothing. Unknown `type` and `reviewTier` labels are accepted.                       |
| Metadata terminology      | Replace "Enrichment" with **Metadata** in the v1 specification, API, glossary, and refresh scope.                                                                                                       |
| Metadata storage          | Replace the catch-all `game_enrichment` table with source-named tables: `steamspy_appdetails`, `storefront_appdetails`, and `steam_review_summaries`.                                                   |
| Metadata refresh          | No TTL for any external metadata source. Every explicit `metadata` refresh fetches SteamSpy, the storefront, and Steam reviews for the selected Games.                                                  |
| Review fields             | `reviewScore` (0-100 percent positive), `reviewTier` (Steam's `review_score_desc`), and `reviewCount` (`total_reviews`) are v1 Fields.                                                                  |
| Review source             | Official Steam reviews from `store.steampowered.com/appreviews/<appid>`. It is a third metadata source and shares the storefront host budget.                                                           |
| Evaluation implementation | A pure, deterministic evaluator over the current Library. It may run in memory or compile to SQL, but the semantics below are the contract.                                                             |

## 2. Rule object

```json
{
  "prefix": "AND",
  "field": "tag",
  "operator": "has",
  "value": "Co-op"
}
```

- `prefix` is exactly `AND`, `OR`, or `NOT`. It is stored as an uppercase string.
- `field` is one of the IDs in [§3](#3-field-registry). It is case-sensitive.
- `operator` is one of `is`, `contains`, `has`, `in`, `lt`, `lte`, `gt`, and `gte`. It is
  lowercase and case-sensitive.
- `value` is JSON. Its required type is defined by the Field and Operator. The server stores the
  exact JSON supplied and never coerces it; validation rejects a value of the wrong type or shape.
- Rules are ordered by `position` (zero-based, contiguous) for display and short-circuit
  evaluation. The result does not depend on array order because Prefixes group globally.
- A Smart Collection has 0-100 Rules. The transport guards from #3 still apply: each serialized
  `value` is at most 16 KiB and the request body is at most 256 KiB.
- There is no `isNot`, `notHas`, or `notIn` operator. Negation is the `NOT` Prefix.
- A Rule has no ID in the API; array position is the client-side identity while editing.

## 3. Field registry

| Field             | Value type          | Operators                | Source                                        | Missing value                         |
| ----------------- | ------------------- | ------------------------ | --------------------------------------------- | ------------------------------------- |
| `name`            | text                | `is`, `contains`         | `games.name`                                  | never missing                         |
| `playtime`        | integer minutes     | `lt`, `lte`, `gt`, `gte` | `games.playtime_minutes`                      | never missing; `0` is a real value    |
| `installed`       | boolean             | `is`                     | `games.installed`                             | `NULL` means unknown                  |
| `ownershipStatus` | enum                | `is`                     | `games.ownership_status`                      | never missing                         |
| `lastPlayed`      | date                | `lt`, `lte`, `gt`, `gte` | `v_games.last_played_at`                      | `NULL` means never or unknown         |
| `releaseYear`     | integer year        | `lt`, `lte`, `gt`, `gte` | `storefront_appdetails.release_year`          | `NULL` means unknown                  |
| `metacriticScore` | integer 0-100       | `lt`, `lte`, `gt`, `gte` | `storefront_appdetails.metacritic_score`      | `NULL` means unknown                  |
| `reviewScore`     | integer 0-100       | `lt`, `lte`, `gt`, `gte` | `steam_review_summaries` counts, computed     | `NULL` means no usable review summary |
| `reviewTier`      | text, open enum     | `is`                     | `steam_review_summaries.review_tier`          | `NULL` means no usable review summary |
| `reviewCount`     | integer count       | `lt`, `lte`, `gt`, `gte` | `steam_review_summaries.review_total`         | `NULL` means unknown; `0` is known    |
| `type`            | text, open enum     | `is`                     | `storefront_appdetails.type`                  | `NULL` means unknown                  |
| `platform`        | enum, multi-valued  | `has`                    | `storefront_appdetails.platforms_json`        | empty set when unknown                |
| `genre`           | text, multi-valued  | `has`                    | `storefront_appdetails.genres_json`           | empty set when unknown                |
| `category`        | text, multi-valued  | `has`                    | `storefront_appdetails.categories_json`       | empty set when unknown                |
| `developer`       | text, multi-valued  | `has`                    | `storefront_appdetails.developers_json`       | empty set when unknown                |
| `publisher`       | text, multi-valued  | `has`                    | `storefront_appdetails.publishers_json`       | empty set when unknown                |
| `tag`             | text, multi-valued  | `has`                    | `tags`, `game_tags`                           | empty set when unknown                |
| `steamCollection` | Steam Collection ID | `has`                    | `steam_collections`, `steam_collection_games` | empty set when unknown                |
| `game`            | App ID list         | `in`                     | `games.app_id`                                | never missing                         |

Operator semantics:

| Operator   | Types                     | Meaning                                                          |
| ---------- | ------------------------- | ---------------------------------------------------------------- |
| `is`       | text, enum, boolean       | Normalized equality. `installed` accepts JSON `true` or `false`. |
| `contains` | text                      | Normalized substring. No wildcards, regex, or tokenization.      |
| `has`      | multi-valued text or enum | Normalized membership: at least one element equals the value.    |
| `in`       | App ID list               | The Game's `appId` is a member of the value array.               |
| `lt`       | integer, date             | Strictly less than.                                              |
| `lte`      | integer, date             | Less than or equal to.                                           |
| `gt`       | integer, date             | Strictly greater than.                                           |
| `gte`      | integer, date             | Greater than or equal to.                                        |

There is no numeric or date `is`. An exact integer or date can be expressed with `gte X` and
`lte X` together; the UI may offer that as a convenience but must emit the two Rules.

## 4. Field semantics

### 4.1 Text and enum normalization

`name`, `tag`, `genre`, `category`, `developer`, `publisher`, `type`, `reviewTier`,
`ownershipStatus`, and the text equivalents of enum values use the shared `name_key`
normalization from #3 §4.4: `NFC`, trim, then lowercase. The display form is preserved; matching
uses the normalized form.

- `is` compares normalized strings for equality.
- `contains` searches for the normalized value as a substring of the normalized Field value.
- `has` compares the normalized value with every element of a multi-valued Field.
- `ownershipStatus` is a closed enum: `owned`, `local_only`, or `unknown`.
- `platform` is a closed enum: `windows`, `mac`, or `linux`.
- `type` and `reviewTier` are open text enums. A new storefront type or Steam review label does not
  require a grammar change.
- `steamCollection` IDs are opaque and case-sensitive. Do not normalize an ID.

Text values are trimmed for the emptiness check but are stored exactly as supplied, per #3. A
value that normalizes to empty is invalid. A value with leading or trailing whitespace is valid
and matches the trimmed form.

### 4.2 Single-valued Fields

`name` is the display name. `is` is an exact normalized match; `contains` is the useful form.

`playtime` is the resolved Playtime in whole minutes. `0` is a real value, not "unknown". The
comparison is numeric and integer-only.

`installed` is `true`, `false`, or unknown (`NULL`). `is true` and `is false` match only the
corresponding known state; neither matches `NULL`. See [§6](#6-missing-and-unknown-values).

`ownershipStatus` is the Ownership value from #3.

`lastPlayed` is the UTC calendar date of `v_games.last_played_at`. The stored value is Unix
seconds; the evaluator converts it to a UTC date and compares date ordinals. A game last played at
`2024-01-01T00:00:00Z` is on `2024-01-01`; a game last played at `2023-12-31T23:59:59Z` is on
`2023-12-31`. `lt "2024-01-01"` includes the latter and excludes the former; `lte` includes the
former. A `NULL` timestamp never matches.

`releaseYear`, `metacriticScore`, `reviewScore`, and `reviewCount` are integers with the bounds in
[§7](#7-validation). They are nullable and never treated as zero.

`reviewScore` is the percentage of positive reviews, rounded half away from zero:
`round(100 * review_positive / review_total)`, clamped to 0-100. It is `NULL` when
`review_total` is `NULL` or `0`.

`reviewTier` is Steam's `review_score_desc` string, for example `Very Positive` or `Mixed`. It is
`NULL` when the Game has no usable review summary. "No user reviews" is not stored as a tier.

`reviewCount` is `total_reviews`. A known zero is `0`; unknown is `NULL`. This distinction matters:
`reviewCount lt 10` matches a Game with a known zero, but not a Game whose review data is missing.

`type` is the storefront `type` (`game`, `dlc`, `demo`, `application`, `tool`, and so on).

### 4.3 Multi-valued Fields

`platform`, `genre`, `category`, `developer`, `publisher`, `tag`, and `steamCollection` are
membership tests. The value is a single string; multiple values require multiple Rules with
`AND` or `OR` as appropriate. This is deliberate: the only list-valued Field in v1 is `game`.

- A Game with no storefront metadata has an empty set for `platform`, `genre`, `category`,
  `developer`, and `publisher`. A positive `has` fails; `NOT` can match.
- A Game with no usable Tag payload has an empty set for `tag`.
- `tag` matches the SteamSpy Tag name; vote counts are not part of v1. A Tag with one vote and a
  Tag with 100,000 votes match identically.
- `category` is the Storefront Category, not a Steam Collection.
- `steamCollection` value is the Steam Collection **ID** (`favorite`, `hidden`, `uc-...`,
  `from-tag-...`, and so on), not its name. Steam Collection names are not unique and can be
  renamed. Static membership only: Favorites and Hidden are static and match; `from-tag-*`
  snapshots are static and match; dynamic `filterSpec` collections have no membership rows and
  never match. An unknown or deleted ID also never matches. The value ID is not validated
  against the current mirror, so a Rule can be saved before the first Steam scan.

### 4.4 The Game Field

`game` is the hand-picked Game list. The value is a JSON array of 1-1000 unique positive App IDs:

```json
{
  "prefix": "AND",
  "field": "game",
  "operator": "in",
  "value": [620, 4000]
}
```

The evaluator tests the Game's `appId` for membership. App IDs not in the current Library are
allowed and simply never match. `NOT game in [...]` excludes the listed Games. Order is
irrelevant; duplicates are rejected by validation rather than silently deduplicated.

## 5. Evaluation

For a Smart Collection or preview with Rules `R`:

```text
matches(R, game) =
    all(AND Rules match)
    AND (there are no OR Rules OR at least one OR Rule matches)
    AND (no NOT Rule matches)
```

Consequences:

- Empty `R`: all three clauses are vacuously true, so every Game matches.
- Only AND Rules: every AND Rule must match.
- Only OR Rules: at least one OR Rule must match.
- Only NOT Rules: every Game matches except those vetoed by a NOT Rule.
- An OR group does not rescue a failed AND Rule. An AND Rule does not rescue an empty OR group.
- Duplicate Rules are allowed and all apply. Contradictory Rules are allowed and can make the
  result empty.
- A NOT Rule is a veto. `NOT tag has "Horror"` means "remove Games that are tagged Horror"; it
  does not require the Game to have a Tag or to be known not to be Horror.

### 5.1 Reference algorithm

```ts
type Prefix = "AND" | "OR" | "NOT";

function matches(rules: Rule[], game: Game): boolean {
  for (const rule of rules) {
    if (rule.prefix === "AND" && !test(rule, game)) return false;
  }

  const orRules = rules.filter((rule) => rule.prefix === "OR");
  if (orRules.length > 0 && !orRules.some((rule) => test(rule, game))) {
    return false;
  }

  for (const rule of rules) {
    if (rule.prefix === "NOT" && test(rule, game)) return false;
  }

  return true;
}

function test(rule: Rule, game: Game): boolean {
  const actual = readField(rule.field, game);

  if (actual === null || actual === undefined) return false;

  switch (rule.operator) {
    case "is":
      if (typeof actual === "boolean") return actual === rule.value;
      return normalize(actual) === normalize(rule.value);
    case "contains":
      return normalize(actual).includes(normalize(rule.value));
    case "has":
      return actual.some((item) =>
        rule.field === "steamCollection"
          ? item === rule.value
          : normalize(item) === normalize(rule.value),
      );
    case "in":
      return rule.value.includes(game.appId);
    case "lt":
      return compare(actual, rule.value) < 0;
    case "lte":
      return compare(actual, rule.value) <= 0;
    case "gt":
      return compare(actual, rule.value) > 0;
    case "gte":
      return compare(actual, rule.value) >= 0;
    default:
      return false;
  }
}
```

`readField` returns `null` for a nullable Field with no value, and an empty array for a
multi-valued Field with no values. `compare` uses integer comparison for numbers and UTC date
ordinals for dates. `normalize` is `NFC`, trim, lowercase; it applies to text and enum elements,
never to a Steam Collection ID. The implementation must not coerce `null` to `0`, `false`, `""`,
or `[]`.

### 5.2 Determinism and order

Evaluation is deterministic and pure: no network, clock, random, or database writes. The same
Rules and the same Library produce the same membership. Rules are evaluated in `position` order
within each Prefix group and may short-circuit:

- AND stops at the first non-match.
- OR stops at the first match.
- NOT stops at the first match.

Grouping is global, so short-circuiting changes only performance and per-Rule diagnostics, not the
result. Pagination and sorting apply after membership is computed; #3's `appId ASC` tiebreaker
remains.

The reference implementation evaluates in memory over the joined Library rows (`v_games` plus
Tags and Steam Collections), then sorts and pages. A 20,000-Game Library with 100 Rules is a small
predicate workload. A SQL compilation is allowed if it produces identical results, including the
missing-value behavior.

## 6. Missing and unknown values

| Field                                                                               | Missing means            | Positive comparison | NOT Rule effect |
| ----------------------------------------------------------------------------------- | ------------------------ | ------------------- | --------------- |
| `installed`                                                                         | `NULL` (not yet scanned) | false               | may match       |
| `lastPlayed`                                                                        | never played or unknown  | false               | may match       |
| `releaseYear`, `metacriticScore`, `reviewScore`, `reviewTier`                       | no usable Metadata       | false               | may match       |
| `reviewCount`                                                                       | unknown                  | false               | may match       |
| `type`                                                                              | unknown                  | false               | may match       |
| `platform`, `genre`, `category`, `developer`, `publisher`, `tag`, `steamCollection` | empty set                | false               | may match       |
| `name`, `playtime`, `ownershipStatus`, `game`                                       | never missing            | —                   | —               |

The rule "a NOT Rule can match a missing value" is intentional. A user who writes "exclude
Horror" should not lose a Game with missing Metadata by accident; the Game is included because the
engine cannot prove it is Horror. The UI should explain this in the Rule editor, not hide it.

A known zero is not missing. There is no `is` operator for `playtime`; use `playtime lt 1` to
match exactly zero. `reviewCount lt 10` matches a known zero and not an unknown count.

There is no first-class `is null` or `is unknown` operator in v1. The consequence can be targeted
with a negated tautology, for example `NOT installed is true` plus `NOT installed is false` leaves
only unknown installed state, and `NOT reviewScore gte 0` leaves only a missing review score.
These are valid but advanced; the UI is not required to surface them.

## 7. Validation

Validation happens at the HTTP boundary for `POST /api/rules/preview`, `POST
/api/smart-collections`, and `PATCH /api/smart-collections/{id}`. The same validator is used for
preview and persistence. Errors use #3's single error shape with `details.fieldErrors` keyed by
dotted path, for example `rules.0.value`.

| Case                                                                     | Result                                       |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| Unknown `field`                                                          | `422 VALIDATION_ERROR` at `rules.N.field`    |
| Unknown `operator`                                                       | `422 VALIDATION_ERROR` at `rules.N.operator` |
| Operator not allowed for the Field                                       | `422 VALIDATION_ERROR` at `rules.N.operator` |
| Unknown or lowercase `prefix`                                            | `422 VALIDATION_ERROR` at `rules.N.prefix`   |
| Value has the wrong JSON type                                            | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `installed` value is not a boolean                                       | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `playtime` is negative, non-integer, or not a safe integer               | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `releaseYear` is outside 1000-9999 or not an integer                     | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `metacriticScore` or `reviewScore` is outside 0-100                      | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `reviewCount` is negative or not an integer                              | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `lastPlayed` is not a real `YYYY-MM-DD` date                             | `422 VALIDATION_ERROR` at `rules.N.value`    |
| Text normalizes to empty, is over 200 code points, or has controls       | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `reviewTier` or `type` normalizes to empty                               | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `steamCollection` is empty or over 128 characters                        | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `game` is not an array of 1-1000 unique positive integers                | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `ownershipStatus` is not `owned`, `local_only`, or `unknown`             | `422 VALIDATION_ERROR` at `rules.N.value`    |
| `platform` is not `windows`, `mac`, or `linux`                           | `422 VALIDATION_ERROR` at `rules.N.value`    |
| Unknown Tag, Genre, Category, Developer, Publisher, Type, or Review Tier | allowed; the Rule matches nothing            |
| Unknown or dynamic `steamCollection` ID                                  | allowed; the Rule matches nothing            |
| Duplicate Rules                                                          | allowed                                      |
| Empty Rules array                                                        | allowed; matches every Game                  |
| More than 100 Rules                                                      | `422 VALIDATION_ERROR` at `rules`            |
| Serialized `value` over 16 KiB                                           | `422 VALIDATION_ERROR` at `rules.N.value`    |

Bounds:

- `playtime`: non-negative safe integer minutes.
- `releaseYear`: integer 1000-9999.
- `metacriticScore` and `reviewScore`: integer 0-100.
- `reviewCount`: non-negative safe integer.
- `lastPlayed`: real Gregorian date from 1970-01-01 through 9999-12-31, UTC.
- Text values: 1-200 Unicode code points after normalization; no C0 or C1 control characters.
- `steamCollection`: 1-128 characters; not normalized.
- `game`: 1-1000 unique positive safe integers.

A Field's value type is fixed by the registry; the server never accepts a string for a number, a
number for a boolean, or an array for a single-valued Field. The `rules` table remains opaque at
the database layer; the API owns this validation.

## 8. Worked test cases

The fixture is a small Library with static Favorites and Hidden Collections, several static user
Collections, one dynamic user Collection, and one unknown Collection ID. `uc-dynamic` has no
membership rows; `uc-missing` does not exist.

Local and ownership data:

| appId | Name     | ownershipStatus | installed | playtime | lastPlayed |
| ----- | -------- | --------------- | --------- | -------- | ---------- |
| 10    | Alpha    | owned           | true      | 3602     | 2025-01-02 |
| 570   | Gamma    | owned           | false     | 0        | NULL       |
| 620   | Portal 2 | owned           | true      | 612      | 2024-01-02 |
| 700   | Zeta     | owned           | true      | 120      | 2023-06-15 |
| 800   | Theta    | owned           | false     | 0        | NULL       |
| 999   | Epsilon  | unknown         | NULL      | 0        | NULL       |
| 4000  | Delta    | local_only      | false     | 0        | NULL       |

Storefront data:

| appId | type | platforms           | genres               | categories           | developers | publishers | releaseYear | metacriticScore |
| ----- | ---- | ------------------- | -------------------- | -------------------- | ---------- | ---------- | ----------- | --------------- |
| 10    | game | windows, linux      | Action, Free to Play | Multi-player         | Valve      | Valve      | 2012        | NULL            |
| 570   | game | windows, mac, linux | Action, Strategy     | Multi-player         | Valve      | Valve      | 2013        | 90              |
| 620   | game | windows, mac, linux | Action, Adventure    | Single-player, Co-op | Valve      | Valve      | 2011        | 95              |
| 700   | dlc  | windows             | Action               | Single-player        | Valve      | Valve      | 2020        | 70              |
| 800   | game | windows             | Indie                | Single-player        | IndieDev   | IndiePub   | 2019        | 80              |
| 999   | NULL | none                | none                 | none                 | none       | none       | NULL        | NULL            |
| 4000  | game | windows, mac, linux | Indie                | Single-player        | Facepunch  | Valve      | 2006        | NULL            |

Tags, Steam Collections, and reviews:

| appId | tags               | steamCollections  | reviewScore | reviewTier              | reviewCount | reviewStatus |
| ----- | ------------------ | ----------------- | ----------- | ----------------------- | ----------- | ------------ |
| 10    | FPS, Shooter       | favorite          | 85          | Very Positive           | 1000        | ok           |
| 570   | MOBA, Free to Play | uc-moba           | 80          | Very Positive           | 2000        | ok           |
| 620   | Puzzle, Co-op      | favorite, uc-coop | 98          | Overwhelmingly Positive | 5000        | ok           |
| 700   | Action             | none              | 60          | Mixed                   | 50          | ok           |
| 800   | none               | none              | NULL        | NULL                    | 0           | unavailable  |
| 999   | none               | hidden            | NULL        | NULL                    | NULL        | missing      |
| 4000  | Sandbox            | uc-sandbox        | NULL        | NULL                    | NULL        | missing      |

Rules are written `PREFIX field operator value`. Values are JSON, so strings are quoted. Expected
matches are ascending `appId`.

| #   | Rules                                                                       | Matches                           | Proves                                    |
| --- | --------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------- |
| 1   | none                                                                        | 10, 570, 620, 700, 800, 999, 4000 | Empty Rules match all                     |
| 2   | `AND tag has "Co-op"`; `AND playtime lt 1000`                               | 620                               | AND requires every Rule                   |
| 3   | `AND tag has "Co-op"`; `AND playtime gt 1000`                               | none                              | One failed AND rejects the Game           |
| 4   | `OR tag has "Puzzle"`; `OR tag has "MOBA"`                                  | 570, 620                          | OR needs one match                        |
| 5   | `OR tag has "Horror"`; `OR tag has "Racing"`                                | none                              | OR with no match rejects                  |
| 6   | `AND installed is true`; `OR genre has "Puzzle"`; `OR genre has "Strategy"` | 620                               | AND and OR combine                        |
| 7   | `NOT tag has "Co-op"`                                                       | 10, 570, 700, 800, 999, 4000      | NOT vetoes                                |
| 8   | `NOT installed is true`                                                     | 570, 800, 999, 4000               | NOT includes false and unknown            |
| 9   | `NOT tag has "Horror"`                                                      | 10, 570, 620, 700, 800, 999, 4000 | Missing Tags do not trigger a veto        |
| 10  | `AND metacriticScore gte 90`                                                | 570, 620                          | Numeric bound                             |
| 11  | `AND metacriticScore lt 95`                                                 | 570, 700, 800                     | Missing scores are excluded               |
| 12  | `AND installed is false`                                                    | 570, 800, 4000                    | `NULL` is not false                       |
| 13  | `NOT installed is false`                                                    | 10, 620, 700, 999                 | `NULL` survives the NOT                   |
| 14  | `AND playtime gte 600`; `AND playtime lt 3600`                              | 620                               | Integer range                             |
| 15  | `AND lastPlayed lt "2025-01-01"`                                            | 620, 700                          | UTC date comparison                       |
| 16  | `AND lastPlayed lte "2024-01-02"`                                           | 620, 700                          | Inclusive date bound                      |
| 17  | `NOT lastPlayed lt "2025-01-01"`                                            | 10, 570, 800, 999, 4000           | Never-played survives the NOT             |
| 18  | `AND reviewScore gte 90`                                                    | 620                               | Review Score                              |
| 19  | `AND reviewTier is "very positive"`                                         | 10, 570                           | Case-insensitive tier                     |
| 20  | `AND reviewCount gte 3000`                                                  | 620                               | Review Count                              |
| 21  | `AND game in [620, 4000]`                                                   | 620, 4000                         | Hand-picked list                          |
| 22  | `NOT game in [620]`                                                         | 10, 570, 700, 800, 999, 4000      | Negated hand-picked list                  |
| 23  | `AND steamCollection has "favorite"`                                        | 10, 620                           | Static Steam Collection by ID             |
| 24  | `AND steamCollection has "uc-dynamic"`                                      | none                              | Dynamic collection never matches          |
| 25  | `AND steamCollection has "uc-missing"`                                      | none                              | Unknown collection never matches          |
| 26  | `AND genre has "action"`                                                    | 10, 570, 620, 700                 | Multi-valued membership, case-insensitive |
| 27  | `AND platform has "linux"`                                                  | 10, 570, 620, 4000                | Multi-valued platform                     |
| 28  | `AND name contains "portal"`                                                | 620                               | Normalized substring                      |
| 29  | `AND type is "game"`                                                        | 10, 570, 620, 800, 4000           | Open enum, excludes DLC and unknown       |
| 30  | `AND ownershipStatus is "local_only"`                                       | 4000                              | Enum equality                             |
| 31  | `AND playtime gt 1000`; `AND playtime lt 100`                               | none                              | Contradictory Rules                       |
| 32  | `AND tag has "Co-op"`; `AND tag has "Co-op"`                                | 620                               | Duplicate Rules                           |
| 33  | `AND reviewCount lt 10`                                                     | 800                               | Known zero matches; unknown does not      |
| 34  | `NOT reviewCount lt 10`                                                     | 10, 570, 620, 700, 999, 4000      | Unknown survives; known zero is vetoed    |
| 35  | `AND releaseYear gte 2011`                                                  | 10, 570, 620, 700, 800            | Year range                                |
| 36  | `AND name is "portal 2"`                                                    | 620                               | Normalized exact text                     |

## 9. Steam review source

### 9.1 Contract

`reviewScore`, `reviewTier`, and `reviewCount` need a third metadata source: Steam's review
summary.

```http
GET https://store.steampowered.com/appreviews/<appid>?json=1&language=all&purchase_type=all&num_per_page=0&l=english
```

- One request per Game, summary only. `num_per_page=0` avoids fetching individual reviews.
- `language=all` and `purchase_type=all` match Steam's all-language, all-purchase-type summary.
- `l=english` pins the review label language; the Fields are English text.
- The response is a JSON object with `success` (`1` on success) and `query_summary`:
  `review_score_desc`, `total_positive`, `total_negative`, and `total_reviews`. Unknown fields are
  ignored.
- This is an unofficial endpoint on `store.steampowered.com`; it is not part of the documented
  Steam Web API. The adapter must be replaceable and must fail closed.
- No new credentials are required.

`steam-cat` uses the same endpoint and parameters, so the shape is established prior art. From the
environment where this section was written, the endpoint returned `302` to the store home while
`appdetails` worked; that is recorded as an operational risk in [§12](#12-open-questions), not as a
different contract.

### 9.2 Response handling

| Upstream result                                           | Stored effect                                                                  | `review_status` | Source state         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- | -------------------- |
| `200`, `success = 1`, `total_reviews > 0`, non-empty tier | Store counts and tier; compute score; set `review_fetched_at`                  | `ok`            | `ok`                 |
| `200`, `success = 1`, `total_reviews = 0`                 | Store `review_total = 0`; clear score and tier                                 | `unavailable`   | `ok` or `partial`    |
| `200`, `success = 0` or missing `query_summary`           | Keep last-known-good values if any; otherwise clear them; record the response  | `unavailable`   | `ok` or `partial`    |
| `200`, malformed JSON or inconsistent counts              | Keep last-known-good values if any; record a short error                       | `error`         | `error` or `partial` |
| `3xx`, HTML instead of JSON, or `403`                     | Treat as blocked; do not parse; keep cached values; stop the source for 15 min | `stale`/`error` | `blocked`            |
| `429`                                                     | Honour `Retry-After`; keep cached values                                       | `stale`/`error` | `rate_limited`       |
| `5xx`, timeout, or network error                          | Retry with backoff; keep cached values                                         | `stale`/`error` | `error` or `offline` |

Rules:

- `success` must be the integer `1`, and `query_summary` must be an object.
- Counts must be non-negative integers. `total_positive + total_negative` must equal
  `total_reviews`; a mismatch is a malformed response, not a silent correction.
- `stale` is used when last-known-good review values exist; use `error` when there is no cache.
  The source state still records `blocked`, `rate_limited`, or `error` independently.
- `reviewScore` is computed from `total_positive / total_reviews`; `reviewCount` is
  `total_reviews`; `reviewTier` is the exact `review_score_desc`.
- A known zero is stored as `review_total = 0`, with `reviewScore` and `reviewTier` null.
  An unknown value is stored as `NULL`, with `review_status = missing`, `stale`, or `error`.
- No review-bomb adjustment, language filter, or purchase-type filter beyond the request above.
- A failed review fetch never hides a Game and never removes the other metadata sources.

### 9.3 Refresh and rate budget

- There is **no TTL** for any external metadata source. Every explicit `metadata` refresh fetches
  SteamSpy, the storefront, and Steam reviews for the selected Games. `appIds` narrows the
  selection; an omitted `appIds` means all Games.
- There is no scheduler in v1. "On demand" means the user's explicit `metadata` or `all` refresh.
  Ownership (Steam Web API) and the local Steam scan remain their own `ownership` and `library`
  scopes; neither has a TTL, and both are already fetched only on explicit refresh.
- The storefront and review requests share `store.steampowered.com`: one in-flight request per
  host and a shared budget of about 200 requests per 5 minutes. They do not get 200 each.
- SteamSpy stays independent at about 1 request per second and may run in parallel with the
  store-host pass.
- A full 10,000-Game metadata refresh therefore makes two store-host requests per Game: roughly
  8.3 hours, versus 4.2 hours with the storefront alone. SteamSpy remains roughly 2.8 hours in
  parallel. The run is a background job; the UI progressively fills.
- `tags_fetched_at`, `store_fetched_at`, and `review_fetched_at` remain diagnostic and API
  timestamps. They no longer drive a TTL or an automatic skip.
- `stale` is now a failure state, not an age state: the last attempt failed and cached values are
  being served. `error` means the last attempt failed with no usable cached values, or the
  response was malformed.
- `metadata` and `all` are the only scopes that fetch metadata. `all` runs `library`, then
  `ownership`, then `metadata`. `appIds` is valid only with `metadata`.

## 10. Schema, API, and terminology delta

This section supersedes the corresponding parts of #3 and #5. #8 folds the delta into the final
v1 specification; the existing draft sections remain readable until then.

### 10.1 Metadata instead of Enrichment

Replace "Enrichment" with **Metadata** throughout the v1 specification, glossary, API, and
refresh contract. The domain term is defined in [GLOSSARY.md](../../GLOSSARY.md). The source-named
tables below replace the catch-all `game_enrichment` table.

Specific API changes:

- `GameSummary.enrichment` and `GameDetail.enrichment` become `metadata`.
- `Status.enrichment` becomes `Status.metadata`.
- `POST /api/refresh` accepts scope `metadata` in place of `enrichment`.
- `refresh_runs.scope` accepts `library`, `ownership`, `metadata`, or `all`.
- `GameSummary.metadata` contains `tagsStatus`, `storeStatus`, and `reviewStatus`.
  `GameDetail.metadata` also contains `tagsFetchedAt`, `storeFetchedAt`, and `reviewFetchedAt`.
- `Status.metadata` contains `tags`, `store`, and `reviews` count objects plus `lastSuccessAt`.
- `GET /api/games` keeps the flat `tagsStatus` and `storeStatus` filters and adds
  `reviewStatus`.
- `Status.sources` contains five entries, ordered `steam_local`, `steam_web_api`, `steamspy`,
  `storefront`, and `steam_reviews`.
- The response's top-level `meta` object is unrelated to the per-Game `metadata` object.

The `Refresh` glossary entry's scopes become `library`, `ownership`, `metadata`, and `all`.

### 10.2 Source-named metadata tables

`game_enrichment` is replaced by three tables, each keyed by `app_id` with
`ON DELETE CASCADE`:

`steamspy_appdetails`:

- `app_id`, `steamspy_name`
- `tags_status`, `tags_fetched_at`, `tags_error`
- `raw_steamspy_json`, `updated_at`

`storefront_appdetails`:

- `app_id`, `type`
- `developers_json`, `publishers_json`, `genres_json`, `categories_json`, `platforms_json`
- `release_date_raw`, `release_year`, `metacritic_score`
- `store_status`, `store_fetched_at`, `store_error`
- `raw_store_json`, `updated_at`

`steam_review_summaries`:

```sql
CREATE TABLE steam_review_summaries (
    app_id            INTEGER PRIMARY KEY REFERENCES games(app_id) ON DELETE CASCADE,
    review_positive   INTEGER CHECK (review_positive IS NULL OR review_positive >= 0),
    review_negative   INTEGER CHECK (review_negative IS NULL OR review_negative >= 0),
    review_total      INTEGER CHECK (review_total IS NULL OR review_total >= 0),
    review_tier       TEXT,
    review_status     TEXT NOT NULL DEFAULT 'missing'
                      CHECK (review_status IN ('ok', 'unavailable', 'missing', 'stale', 'error')),
    review_fetched_at INTEGER CHECK (review_fetched_at IS NULL OR review_fetched_at >= 0),
    review_error      TEXT,
    raw_reviews_json  TEXT CHECK (raw_reviews_json IS NULL OR json_valid(raw_reviews_json)),
    updated_at        INTEGER NOT NULL
);
```

`tags` and `game_tags` stay as the normalized Tag vocabulary. `source_state` stays and gains
`steam_reviews` as a fifth name. `source_state`'s `steam_reviews` status vocabulary is `unknown`,
`ok`, `partial`, `stale`, `rate_limited`, `blocked`, `offline`, and `error`.

### 10.3 View and indexes

`v_games` left-joins `steamspy_appdetails`, `storefront_appdetails`, and
`steam_review_summaries` and coalesces a missing row to `tags_status = 'missing'`,
`store_status = 'missing'`, `review_status = 'missing'`, empty JSON arrays, and `{}` platforms.

`v_games` exposes the stored review counts and tier and computes:

```sql
CASE
    WHEN sr.review_total > 0
    THEN MIN(100, CAST(ROUND(100.0 * sr.review_positive / sr.review_total) AS INTEGER))
    ELSE NULL
END AS review_score
```

Replace the old `idx_enrichment_*` indexes with:

- `idx_steamspy_tags_status` on `steamspy_appdetails(tags_status)`
- `idx_storefront_release` on `storefront_appdetails(release_year)`
- `idx_storefront_metacritic` on `storefront_appdetails(metacritic_score)`
- `idx_storefront_status` on `storefront_appdetails(store_status)`
- `idx_steam_reviews_status` on `steam_review_summaries(review_status)`
- `idx_steam_reviews_total` on `steam_review_summaries(review_total)`

### 10.4 Review API shape

`GameSummary` adds:

```json
{
  "reviewScore": 85,
  "reviewTier": "Very Positive",
  "reviewCount": 1000
}
```

All three are nullable. `reviewCount` is `0` for a known no-review Game and `null` when unknown.
`GameDetail` adds the same fields and `metadata.reviewStatus`; `metadata.reviewFetchedAt` is also
in the detail payload.

`Status.metadata.reviews` classifies every Game as `ok`, `unavailable`, `missing`, `stale`, or
`error`. A Game with no row counts as `missing`.

### 10.5 Refresh delta

- The `metadata` scope replaces `enrichment` in `POST /api/refresh`, `refresh_runs.scope`, the
  deduplication rule, and the `appIds` restriction. `refresh_runs.app_ids_json` has the same
  meaning: the normalized selection, or `NULL` for all Games.
- A `metadata` run on an unbound database stores `steam_id64 = NULL`; it does not bind an Account.
- No TTL: every explicit refresh fetches every selected Game from every metadata source.
- The storefront and review passes share the store-host budget. They are serialized; SteamSpy is
  independent.
- A source failure makes the run `partial`, not failed. A blocked source stops for 15 minutes.
- `all` still runs `library`, then `ownership`, then `metadata`.

## 11. Acceptance checks for #8

### Grammar and evaluation

- [ ] Every Field in [§3](#3-field-registry) accepts exactly its listed Operators and rejects an
      unknown Field, unknown Operator, or disallowed Operator with `422 VALIDATION_ERROR`.
- [ ] An empty Rules array matches every Game; only-AND, only-OR, and only-NOT arrays follow
      [§5](#5-evaluation).
- [ ] A missing value never satisfies a positive comparison; a NOT Rule can match it.
- [ ] `installed is false` does not match `NULL`; `NOT installed is false` can.
- [ ] Text and enum matching is case-insensitive and NFC-normalized; Tag votes do not affect
      matching.
- [ ] `game in` accepts 1-1000 unique positive App IDs and rejects duplicates, empty arrays, and
      non-integers.
- [ ] `steamCollection has` matches static membership by ID and never matches a dynamic or
      unknown ID.
- [ ] `lastPlayed` compares UTC dates, uses only range Operators, and returns false for `NULL`.
- [ ] `reviewScore`, `reviewTier`, and `reviewCount` follow the review source rules, including a
      known zero versus unknown.
- [ ] The preview endpoint and a saved Smart Collection with identical Rules and data return the
      same membership.
- [ ] Pagination is stable; Game lists use `appId ASC` as the final tiebreaker.

### Metadata and review source

- [ ] `game_enrichment` no longer exists; the three source-named tables do, and `v_games` joins
      them.
- [ ] `source_state` contains `steam_reviews`; `Status.sources` contains five entries in the
      documented order.
- [ ] `POST /api/refresh` accepts `metadata`; `refresh_runs.scope` uses `metadata`; `appIds` is
      valid only with `metadata`.
- [ ] A `metadata` refresh fetches SteamSpy, storefront, and reviews for every selected Game,
      even when the data was fetched recently.
- [ ] The storefront and review passes never run concurrently against the store host; a `429`
      pauses the shared host.
- [ ] A successful review summary stores counts, tier, status, and timestamp, and computes
      `reviewScore`.
- [ ] `success = 0`, no reviews, malformed JSON, `302`/HTML, `403`, `429`, and `5xx` follow the
      table in [§9.2](#92-response-handling); no failure hides a Game.
- [ ] A Game with no review row returns `reviewScore = null`, `reviewTier = null`,
      `reviewCount = null`, and `reviewStatus = "missing"`.
- [ ] A Game with a successful zero-review summary returns `reviewScore = null`,
      `reviewTier = null`, `reviewCount = 0`, and `reviewStatus = "unavailable"`.
- [ ] `GET /api/games?reviewStatus=missing` returns only Games with that status.
- [ ] `Status.metadata.reviews` classifies every Game exactly once, including missing rows.

### Terminology

- [ ] The v1 specification uses **Metadata**, not Enrichment, except in historical or superseded
      notes.
- [ ] The API exposes `metadata` objects and a `metadata` refresh scope; no `enrichment` object
      or scope remains.
- [ ] `GLOSSARY.md` defines Metadata and no longer defines Enrichment.

## 12. Open questions

- **Review endpoint verification.** `store.steampowered.com/appreviews` returned `302` from the
  environment that wrote this section while `appdetails` worked. `steam-cat` uses the endpoint
  successfully from a normal network. Verify it on the target machine and unblock the host if
  needed; a `302` or HTML response must remain `blocked`, never an empty summary.
- **Review endpoint stability.** The endpoint is unofficial. A future Steam change may require a
  replacement adapter; the review Fields can remain nullable while it is unavailable.
- **Review language and review bombs.** The contract uses Steam's all-language,
  all-purchase-type summary with no review-bomb adjustment. A future Field could expose a
  filtered summary, but it is not v1.
- **Relative Last Played.** `lastPlayed` is an absolute UTC date. A clock-dependent
  `daysSinceLastPlayed` Field is deferred; it would need a documented evaluation clock and
  test fixtures with a fixed now.
- **Tag vote thresholds.** `tag` ignores votes. A future `tagVotes` Field could require a minimum
  vote count.
- **Open enums.** `type` and `reviewTier` accept new labels without a grammar change. The rule
  editor should suggest observed values.
- **Large libraries.** The reference evaluator is in memory. #8 should benchmark a 20,000-Game
  Library with 100 Rules before considering SQL compilation or caching.
- **Dynamic Steam Collection references.** A static collection that later becomes dynamic makes
  existing Rules match nothing. The UI should warn; v1 has no materialized membership to
  substitute.
- **Non-game library entries.** `type` can filter DLC, demos, tools, and soundtracks, but whether
  they are shown by default remains a #1 decision.
- **Multiple Accounts and Family Sharing.** The grammar evaluates one Account's Library; the
  Ownership semantics remain #1/#3 decisions.
