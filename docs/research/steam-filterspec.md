# Steam dynamic collections: `filterSpec`

Status: research note for game-cat v1/v3. Read-only findings; no Steam file was modified.
Scope: what `filterSpec` is, what it can express, how the Steam client evaluates it, and what that
means for importing Steam Collections and for the v3 write-back seam.

## 0. Method and evidence standard

Steam is **not installed** in the environment where this note was written, so no live collection
could be created or observed. Evidence comes from three kinds of sources, labelled throughout:

- **[client code]** Valve-authored (obfuscated) client JavaScript, mirrored by SteamDatabase's
  SteamTracking repository. This is the code that actually parses and evaluates `filterSpec`.
  Cited as `sp.js`, module `22189` (filter class) and the collection store module.
- **[deobf]** A deobfuscated mirror of an older Steam client bundle
  (`ricewind012/steam-ui-unobfuscated`), used because it is readable. Its filter class has the
  same structure and matching rule as the current one; the option lists and group count differ.
  Where the two differ, the current client wins and the difference is called out.
- **[real file]** A real `cloud-storage-namespace-1.json` published in a public repository, with
  one genuine dynamic collection. Names/IDs are not personal data; the sample is quoted only for
  its `filterSpec`.
- **[impl]** Open-source implementations that read or write this format.

I found no Valve documentation for `filterSpec`; the developer wiki and partner docs do not appear
to cover local library collections. Every claim below is therefore reverse-engineered, observed,
or inferred, and is marked accordingly. Confidence levels are in §10.

## 1. Short answer

`filterSpec` is a **fixed, flat filter**: a conjunction of option groups, where each group is
either an AND or an OR over a closed list of Steam-defined options. It is not a general boolean
expression.

It **cannot** express game-cat's rule model. It has no playtime, no release year, no review
score, no HLTB, no free-text tag votes, no arbitrary NOT, and no nested AND/OR. It can express a
useful subset: installed/played state, Steam features (controller, Deck, VR, …), genres and
arbitrary Steam store tags, language, accessibility features, friend-owned games, and the EA
subscription. Explicit app IDs are not a predicate; they live in the sibling `added`/`removed`
arrays and are applied on top of the filter.

Two premises in the ticket need correcting:

1. **`from-tag-*` collections are not dynamic.** The client creates them as *static* snapshots of
   legacy user tags (`CCollection.FromUserTag` sets `m_filter = undefined` and fills `added`), and
   the one real sample inspected has no `filterSpec`. They never carry a filter spec.
2. **`added` is not a dynamic collection's membership.** For a dynamic collection, `added` holds
   only apps the user pinned manually on top of the filter; the rest of the membership is
   computed in memory and never persisted.

Recommendation for v3: **export membership, not `filterSpec`** (§9).

## 2. Where it lives and how it is stored

Collections are entries in

```
<steam>/userdata/<account-id>/config/cloudstorage/cloud-storage-namespace-1.json
```

The file is a JSON array of `[key, entry]` pairs. `entry.value` is a **double-encoded JSON
string**; parse it a second time. [real file, impl]

```json
["user-collections.uc-kBRPKwAbcuQ*+", {
  "key": "user-collections.uc-kBRPKwAbcuQ*+",
  "timestamp": 1762686893,
  "value": "{\"id\":\"uc-kBRPKwAbcuQ*+\",\"name\":\"…\",\"added\":[1007090],\"removed\":[],\"filterSpec\":{ … }}",
  "version": "1937",
  "conflictResolutionMethod": "custom",
  "strMethodId": "union-collections"
}]
```

The inner object is:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `uc-…` for user collections, `favorite`/`hidden` for reserved, `from-tag-…`/`type-…` for generated |
| `name` | string | display name, user-editable |
| `added` | number[] | app IDs pinned into the collection |
| `removed` | number[] | app IDs excluded from the computed membership (dynamic only, see §5) |
| `filterSpec` | object? | **presence of a valid spec makes the collection dynamic** |

A collection is dynamic iff `filterSpec` parses with `nFormatVersion: 2`
(`E6.FromStorageFormat`; any other/absent version returns `null`). The client does not store a
separate `isDynamic` flag. [client code, deobf]

Real observed example — a dynamic "Action" collection with one manually pinned app
[real file]:

```json
{
  "nFormatVersion": 2,
  "strSearchText": "",
  "filterGroups": [
    {"rgOptions": [], "bAcceptUnion": true},
    {"rgOptions": [], "bAcceptUnion": false},
    {"rgOptions": [], "bAcceptUnion": false},
    {"rgOptions": [], "bAcceptUnion": false},
    {"rgOptions": [19], "bAcceptUnion": false},
    {"rgOptions": [], "bAcceptUnion": false},
    {"rgOptions": [], "bAcceptUnion": false}
  ],
  "setSuggestions": {}
}
```

Note: only seven groups were written here. The current client builds **nine** groups and pads
missing ones with empty defaults on read, so readers must tolerate 7–9 groups and treat missing
groups as empty. [client code] Older clients ignore trailing groups they do not know.

`setSuggestions` is effectively opaque: the client models it as a `Set<number>`, JSON serializes
it as `{}`, and no reader should rely on it. Treat it as ignorable.

## 3. Schema sketch (annotated)

```jsonc
{
  "id": "uc-…",              // stable id; Steam generates 9 random bytes, base64-ish,
                             // escaping '%' -> "**" and '/' -> "*+"
  "name": "…",
  "added":   [1007090],      // manual pins (dynamic) OR full membership (static)
  "removed": [],             // manual exclusions; only honoured for dynamic collections
  "filterSpec": {
    "nFormatVersion": 2,     // only 2 is understood; anything else -> static/ignored
    "strSearchText": "",     // name/id substring search, ANDed with the groups
    "filterGroups": [        // fixed positions, each { rgOptions: number[], bAcceptUnion: bool }
      { "rgOptions": [], "bAcceptUnion": true  },  // 0 app type        (system collections only)
      { "rgOptions": [], "bAcceptUnion": false },  // 1 play state
      { "rgOptions": [], "bAcceptUnion": false },  // 2 features
      { "rgOptions": [], "bAcceptUnion": false },  // 3 genre           (written by no UI, ignored by matcher)
      { "rgOptions": [19], "bAcceptUnion": false },// 4 store tags      (genres are tag ids)
      { "rgOptions": [], "bAcceptUnion": false },  // 5 partner subscription (EA Play)
      { "rgOptions": [], "bAcceptUnion": false },  // 6 friends         (family-shared libraries)
      { "rgOptions": [], "bAcceptUnion": false },  // 7 language
      { "rgOptions": [], "bAcceptUnion": false }   // 8 accessibility features
    ],
    "setSuggestions": {}     // ignore
  }
}
```

Group indices are stable across the versions inspected; option **values within a group are not**
and grow over time. [client code; `EFilterGroup` in decky's client typings still lists the older
seven-group enum: AppType, PlayState, AppFeature, Genre, StoreCategory, Partner, Friends.]

## 4. What each group can contain

Option lists below are from the current client (`sp.js`, module `22189`) and the older
deobfuscated mirror. The UI exposes only a subset of each list; the evaluator accepts any value.

| # | Group | Options | Matched against | Notes |
|---|---|---|---|---|
| 0 | App type | `1` game, `2` application, `4` tool, `2048` video, `8192` music album | `canonicalAppType` | Used only by the system-collection subclass (`type-games`, `type-music`, …). A normal user dynamic collection ignores group 0. |
| 1 | Play state | `1` Installed, `2` ReadyToPlay, `3` PlayedPreviously, `4` Unplayed, `5` ValidPlatform, `6` Private | install state, last-played > 0, platform availability | No "not installed"; no time thresholds. |
| 2 | Features | controller support, VR, trading cards, workshop, achievements, single/multi/co-op, cloud, remote play, Deck compatibility, PS4/PS5 pads, Steam Input, HDR, family sharing, SteamOS, Steam Machine, Steam Frame, … | store categories / app overview flags | Values drift; e.g. current client adds SteamOS (`24`–`25`), `NonVRGames` (`26`), `LocalMultiplayer` (`27`), `AnyController` (`28`), Steam Machine (`29`–`31`), Steam Frame (`32`–`34`). |
| 3 | Genre | the ten genre tag IDs: Action `19`, Adventure `21`, Casual `597`, Indie `492`, MMO `128`, Racing `699`, RPG `122`, Simulation `599`, Sports `701`, Strategy `9` | **nothing** | The UI never writes this group; its genre section writes group 4. Both the old and current matchers skip group 3. Treat group-3 options as inert. |
| 4 | Store tags | arbitrary Steam store tag IDs | `BHasStoreTag(id)` | This is the real tag/genre group. UI sections "Genre" and "Store Tag" both write here. Verified by a real spec whose only option is `19` (Action) and by the client's `GetGenreOptions()`/`StoreTagSection`, both using group 4. |
| 5 | Partner | `4000` = EA Play / EA Access | `mastersub_appid == 1289670` | Only used by the `partner-ea-access` collection. |
| 6 | Friends | Steam account IDs | `GetOwnedGames(friend).has(appid)` | Produces "games owned by this friend" (family sharing). |
| 7 | Language | language indices | `bitfield_supported_languages` | UI label `#AdvancedSearch_LanguageSection`. |
| 8 | Accessibility | accessibility store-category IDs | `BHasStoreCategory(id)` | UI sections for visual/audio/input/gameplay accessibility. |

Two consequences that matter for rule mapping:

- Genre and tag are the **same group**. A spec cannot say `(tag A OR tag B) AND (genre RPG)`
  because both operands share one `bAcceptUnion` flag.
- All "features" share one group too, so `(SinglePlayer OR CoOp) AND FullController` is not
  expressible; it collapses to all-AND or all-OR.

## 5. How the client computes membership

From `CCollection.UpdateApps` [deobf, current client equivalent]:

```
setApps = copy(existing membership)
if filter exists and !filter.isEmpty:
    for app in allApps where app.visible_in_game_list:
        if filter.matches(app): setApps.add(app.appid)
        else:                   setApps.delete(app.appid)
    setApps -= appsUnavailableOnThisClient      // second argument
else:
    setApps.clear()                            // empty filter is NOT "all games"

setApps |= added
setApps -= removed
```

`filter.matches` is [client code, deobf]:

```
groupMatch(g, pred) =
    g.options.length == 0 ? true
  : g.bAcceptUnion ? g.options.some(pred)
  :                  g.options.every(pred)

matches(app):
    groupMatch(g1, playStatePred(app))   and
    groupMatch(g2, featurePred(app))     and
    groupMatch(g4, storeTagPred(app))    and
    groupMatch(g5, subscriptionPred(app))and
    groupMatch(g6, friendOwnedPred(app)) and
    groupMatch(g7, languagePred(app))    and
    groupMatch(g8, accessibilityPred(app))
    // group 0 is checked only by the system-collection subclass
    // group 3 is never checked
    and (searchText == "" or name/appid/suggestion match)
```

So the expression is:

```
(g1,1 ∧ g1,2 ∧ …) ∧ (g2,1 ∨ g2,2 ∨ …) ∧ … ∧ (g8,1 ∧ …)
```

with one freely chosen AND/OR per group — a conjunction of fixed-facet clauses. There is no
nesting, no cross-group grouping, and no negation of a clause.

`bIsEmpty` is `strSearchText == "" && every group has no options`. An empty spec does **not**
mean "everything": the client clears membership and falls back to `added` alone. A spec whose
options match nothing also yields an empty collection, not all games.

### 5.1 `added` / `removed` still apply

Yes, and they are part of the persisted contract:

- Dynamic: `filterSpec` is the base; `added` pins apps in, `removed` excludes apps out.
  `effective = (matches(filterSpec) ∪ added) \ removed`.
- Static: there is no filter; membership is `added` (minus nothing). `removed` is not loaded for
  static collections — `MergeFromStorageFormat` only reads `removed` when `bIsDynamic` — so a
  non-empty `removed` on a static collection is ignored/dropped.
- The computed membership is **not written back**. `ToStorageFormat` stores only
  `id/name/added/removed/filterSpec`. Re-opening Steam recomputes from the filter.

This also means the v1 note's "`removed` is meaningful for `from-tag-*`" is not supported by the
current client: `from-tag-*` is static, so only `added` counts.

### 5.2 Conflicts and sync

Steam registers a custom conflict-resolution method named `union-collections`
(`strMethodId: "union-collections"`). Its merge rule takes the newer entry for names/filters but
**unions `added`** and drops any app from `removed` if the other side added it. Consequences:

- A static collection exported by game-cat will accrete apps added on other devices.
- Rewriting a collection with a smaller membership is not reliable through the normal merge path.
- v3 export should treat a collection as append-mostly, or use a fresh id per export, unless it
  writes while Steam is closed and controls `version`.

`version` is a per-namespace monotonic counter stored as a string; existing samples in the
thousands. Export must write a larger value than the current entry.

## 6. What it can and cannot express

Mapping to game-cat's vocabulary (Field / Operator / Value, with AND/OR/NOT prefixes). This uses
the field set sketched for game-cat and present in the predecessor, steam-cat
(`FilterType.java`): APPID, GENRE, TAG, INSTALLED, PLAYTIME_HOURS, RELEASE_YEAR, plus features
such as controller support and Deck compatibility.

| game-cat rule | Expressible? | How / why not |
|---|---|---|
| `installed = true` | yes | group 1 option `1` |
| `installed = false` | **no** | no "not installed" option; `Unplayed` is about play history, not install state |
| `played previously` | yes | group 1 option `3` |
| `unplayed` | yes | group 1 option `4` |
| `playtime >= N hours` | **no** | no playtime option, no numeric comparisons anywhere |
| `release year >= Y` | **no** | no release-date field |
| `genre is RPG` | yes, if mapped to tag `122` | group 4 tag id; genre section writes group 4. Group 3 exists but is inert |
| `tag is Roguelike` | probably | group 4 accepts arbitrary store tag ids; only the 10 genres are exposed by the UI. Tag vocabulary is Steam store tags, not SteamSpy vote data |
| `tag is A AND tag is B` | yes | group 4, `bAcceptUnion: false` |
| `tag is A OR tag is B` | yes | group 4, `bAcceptUnion: true` |
| `genre is RPG AND tag is Roguelike` | **no** | both live in group 4; one combinator for the whole group |
| `NOT (tag is A)` | **no** | no general negation; `removed` can exclude specific app IDs, not a predicate |
| `(A AND B) OR (C AND D)` | **no** | no nesting; only one AND/OR level per facet |
| `appid = 730` | only as membership | app IDs are `added`/`removed` entries, not a filter predicate |
| `controller support = full` | yes | group 2 option `1` (also `28` store category) |
| `Steam Deck = verified` | yes | group 2 options `12`–`14` |
| `language = German` | yes | group 7 |
| `friend X owns it` | yes | group 6 |
| `hidden = true` | **no** | Hidden is a separate reserved collection, not a filter |
| `review score >= 80`, `HLTB <= 10`, `similar to X` | **no** | no such fields |

Operators: only set membership and boolean option checks. There are no numeric operators
(`>`, `<`, `between`), no string operators beyond a single substring search box, and no
per-option negation.

### 6.1 Worked examples

Expressible:

```
Installed AND (RPG OR Strategy) AND not-early-access   -- after mapping genres to tags
→ groups: 1=[1], 4=[122,9] with union=true
```

Not expressible:

```
(playtime >= 10h OR releaseYear >= 2020) AND NOT tag=Roguelike
```

even though each piece looks simple, because playtime and release year have no representation,
and NOT has no representation.

## 7. Import implications for v1

- Dynamic collections have **no stored membership**. `added` is only manual pins. Reading
  `added` alone under-reports the collection, possibly to zero.
- v1 should therefore: parse `filterSpec`, record it, and mark the collection "dynamic
  (not evaluated)" rather than importing a wrong membership. Optionally evaluate the supported
  subset locally, but that needs store metadata game-cat may not have (store tags, categories,
  language bitfield, Deck compat, friends' libraries) and would be an approximation.
- Static collections (`favorite`, `hidden`, `uc-*` without a spec, `from-tag-*`, `type-*`) import
  cleanly as `added`.
- The predecessor steam-cat simply **drops** any collection with a `filterSpec`
  (`filter(e -> !e.hasFilterSpec())`), which is a defensible v1 baseline.
- Prior art agrees on the shape but not on the fix: BoilR and ChimeraOS write/read only
  `added`/`removed` and ignore `filterSpec`; `Steam-Library-Manager` and SamRewritten implement
  partial evaluators; decky's typings expose the struct but not the matcher.

## 8. Versioning and drift

- `nFormatVersion` has only ever been observed as `2`. It is checked strictly; unknown or
  missing means "static".
- The group count grew from 7 to 9 (language and accessibility) without a format-version bump.
  Readers must pad; writers targeting older clients should expect trailing groups to be dropped.
- Option IDs grow with each client release (SteamOS, Steam Machine, Steam Frame were added
  recently). Any evaluator or exporter must treat unknown options as unsupported, not as false.
- Group 3 has been inert in every version inspected. Do not rely on it; it may disappear.
- Group 0 is only honoured by the system-collection subclass; a user dynamic collection with
  group-0 options ignores them.

## 9. Recommendation for the v3 export seam

**Make membership the contract; treat `filterSpec` as an optional, lossy, one-way extra.**

Concretely:

1. **v3 writes static Steam Collections.** Compute the Smart Collection's membership in
   game-cat, then write a `uc-*` entry whose inner object has `added = [appids]`,
   `removed = []`, and **no `filterSpec`**. That is exactly what Steam and every mature tool
   already understand, and it works for every game-cat rule (playtime, year, NOT, nesting,
   HLTB, similarity).
2. **Do not make the rule model fit `filterSpec`.** The filter is a fixed CNF over Steam's
   option vocabulary; game-cat's grammar is strictly richer. Designing to the intersection would
   remove features for no user benefit.
3. **Add a separate, explicit "also create as a Steam dynamic filter" action later**, only for
   rules that map *exactly* (installed/played, a single facet's tags/features, language). Detect
   unsupported rules and refuse or fall back to static rather than silently approximating.
   Keep it one-way: game-cat remains the source of truth.
4. **Export shape.** Write `user-collections.uc-<new-id>` with
   `conflictResolutionMethod: "custom"`, `strMethodId: "union-collections"`, a `version` greater
   than the namespace's current maximum, and a `timestamp`. Omit `filterSpec`. Prefer writing
   `cloud-storage-namespace-1.modified.json` with Steam closed, and re-read after Steam
   restarts. Because the `union-collections` merge unions `added` across devices, a re-export
   should add/remove incrementally or use a stable collection id and accept that deletions may
   be re-unioned; do not promise "the collection in Steam always equals the Smart Collection".
5. **Import contract.** Store `filterSpec` as opaque metadata and expose dynamic collections as
   read-only/unsupported in v1. Never materialise a dynamic collection from `added`.
6. **Seam in code.** A small exporter interface, e.g.
   `exportStatic(name, appIds) -> SteamCollectionRef` now, with a later
   `exportDynamic(name, spec) -> SteamCollectionRef | Unsupported`; the rest of game-cat should
   not know about `filterGroups`.

This is the same conclusion the v1 discovery note reached ("flag dynamic collections as
unsupported rather than inventing membership"), now with the schema and evaluation rules pinned
down.

## 10. Confidence

| Claim | Confidence | Basis |
|---|---|---|
| `filterSpec` shape (`nFormatVersion`, `strSearchText`, `filterGroups[{rgOptions,bAcceptUnion}]`, `setSuggestions`) | **high** | client code + real file + multiple independent implementations |
| Presence of a parseable v2 spec makes a collection dynamic | **high** | `FromStorageFormat`/`bIsDynamic` in client code |
| Per-group AND/OR, cross-group AND | **high** | `groupMatch`/`MatchesImpl` in client code |
| `added`/`removed` layering and non-persistence of computed membership | **high** | `UpdateApps`/`ToStorageFormat` in client code; matches observed `added` alongside a filter |
| `from-tag-*` is static, not dynamic | **high** | `FromUserTag` sets no filter; real file has no spec |
| Group 1 = play state, 2 = features, 4 = store tags, 5 = partner, 6 = friends | **high** | client code + decky typings + SamRewritten constants |
| Group 7 = language, 8 = accessibility | **medium-high** | current client code only; matches SamRewritten; not in older typings |
| Group 3 = genre and is inert in the matcher | **medium-high** | client code in two versions; UI writes genres to group 4 and never to group 3. A hidden caller could still filter on it |
| Group 4 accepts arbitrary Steam store tag IDs | **medium** | matcher is `BHasStoreTag`; UI's tag section writes there; only one real non-empty sample (`19` = Action) observed |
| UI-exposed fields are state/features/genre/tags/language/accessibility/friends | **medium-high** | strings and `eGroup` wiring in current client's advanced-search modal |
| Exact option IDs are stable | **low** | they demonstrably drift per client release |
| Hand-written `filterSpec` is accepted and recomputed by Steam | **low** | no live test; community tools write it, but survival through Cloud sync is unverified |
| `union-collections` merge semantics | **medium** | client conflict-resolution function; not exercised against a server |

## 11. Still needs a real client

These are the load-bearing unknowns that only a live Steam install can settle:

1. Create a dynamic collection in the current UI (installed + genre + tag + language) and confirm
   which groups/options the client writes, and whether group 3 is ever written.
2. Check whether a hand-written `filterSpec` (same shape) is accepted after restart, whether
   Steam recomputes membership, and whether it rewrites or normalises the spec.
3. Observe whether `filterSpec` entries survive Steam Cloud sync across two devices and whether
   `version` must be bumped manually.
4. Confirm `removed` persists for dynamic collections and survives sync; confirm it is dropped
   for static ones.
5. Confirm the empty-spec behaviour in the UI (empty vs. all games) — client code says empty.
6. Verify group 4 accepts arbitrary store tag IDs beyond the ten genres, and that the IDs are the
   same vocabulary as Steam store tags (name mapping table needed for SteamSpy tags).
7. Record the current option IDs for groups 1, 2, 7, 8 and whether `NFormatVersion` is still 2.
8. Confirm `from-tag-*` is never regenerated/updated after the first bootstrap (client code
   suggests once).
9. Test whether writing `cloud-storage-namespace-1.modified.json` with Steam closed is enough, or
   whether Steam overwrites it from Cloud on next launch.

## 12. Sources

Client code:

- SteamTracking, `ClientExtracted/steamui/sp.js`, module `22189` (filter class: constructor with
  nine groups, `MatchesImpl`, `ToStorageFormat`/`FromStorageFormat`, option tables, `BHasStoreTag`,
  `BHasStoreCategory`, `bitfield_supported_languages`), pinned at commit
  `a70277a355ab0184626ee1b843c657a7ddd6b02e`:
  <https://github.com/SteamTracking/SteamTracking/blob/a70277a355ab0184626ee1b843c657a7ddd6b02e/ClientExtracted/steamui/sp.js>
- Deobfuscated mirror (older seven-group client), `src/chunk~2dcc5aaf7/14629.js` — filter class
  at line 682, constructor 690, `MatchesImpl` 898, `ToStorageFormat` 991, `FromStorageFormat`
  997; `actual_src/stores/collectionstore.ts` — `UpdateApps` 194, `ToStorageFormat` 346,
  `MergeFromStorageFormat` 379, `FromUserTag` 430, conflict merge 512. Pinned at commit
  `3c658f496c3bc713eabd1ebb57c91b4659b83591`:
  <https://github.com/ricewind012/steam-ui-unobfuscated/blob/3c658f496c3bc713eabd1ebb57c91b4659b83591/src/chunk~2dcc5aaf7/14629.js#L682>
  and
  <https://github.com/ricewind012/steam-ui-unobfuscated/blob/3c658f496c3bc713eabd1ebb57c91b4659b83591/actual_src/stores/collectionstore.ts#L194>
- Type declaration of the filter spec from the client's shared JS context:
  <https://github.com/ricewind012/steam-sharedjscontext-types/blob/ffb84686ed05a37c157150faf617e3af6bf848b7/generated/uiStore.ts>
- `EFilterGroup` / `EStoreCategory` / `EAppFeature` client typings (older seven-group snapshot):
  <https://github.com/SteamDeckHomebrew/decky-frontend-lib/blob/52d1173edd370524d58fe4fe703eb70930c91d53/src/globals/stores/collectionstore.ts#L34>

Real file:

- `cloud-storage-namespace-1.json` containing a genuine dynamic collection (Action tag `19`,
  `added: [1007090]`), pinned at commit
  `4a7491e72ce638830d621cc5e6fcfbcf7de39562`:
  <https://github.com/SmallRob/steam-namespace/blob/4a7491e72ce638830d621cc5e6fcfbcf7de39562/cloud_old_src/json-config/formatted-cloud-storage-namespace.json>

Reference implementations:

- SamRewritten — independent Rust model and partial evaluator, with group constants
  (1/2/4/5/6/7/8), `group_matches`, `unsupported_reason`, and synthetic fixtures:
  <https://github.com/PaulCombal/SamRewritten/blob/37716b1600eb52a0b9a4abd0543e50d96335fcfb/src/backend/steam_collections.rs#L31>
- Steam-Library-Manager — reads and writes dynamic collections, builds the nine-group array:
  <https://github.com/dtq1997/Steam-Library-Manager/blob/master/core.py> (`filter_groups` around
  line 1605)
- steam-cat (predecessor) — drops collections that have a `filterSpec`, imports `added` only:
  <https://github.com/fran2889/steam-cat/blob/e0644e465e23b11a1486ceac9c1fa85af57d437f/src/main/java/hr/fran/steamcat/steam/SteamCollectionService.java#L137>
  and its rule vocabulary: `.../collection/filter/FilterType.java`
- BoilR — reads/writes `added`/`removed` only, no `filterSpec`:
  <https://github.com/PhilipK/BoilR/blob/main/crates/boilr-core/src/steam/collections.rs>
- ChimeraOS — collection writes are `{id, name, added, removed}` only:
  <https://github.com/ChimeraOS/chimera/blob/master/chimera_app/steam_collections.py>
- Prior game-cat note: `docs/research/steam-local-library.md` §6.1–6.3 (branch
  `research/steam-local-library`), and the predecessor's
  `docs/steam-local-collections.md`.

Accessed 2026-11-13. Pin these SHAs when the findings are promoted into the spec.
