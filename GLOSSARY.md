# game-cat

Game-cat is a local, read-first view of a Steam library: it reads what Steam already knows, adds metadata Steam does not surface well, and lets the user build reusable views over it.

## Language

**Game**:
An entry in the user's Steam library, identified by its Steam App ID. A Game exists whether or not it is installed.
_Avoid_: title, app

**App ID**:
Steam's numeric identifier for a store product. A Game's identity is its App ID.
_Avoid_: appid, app

**Library Alias**:
A Library App ID that Steam's storefront resolves to a different Canonical App ID.
_Avoid_: alias, redirect

**Canonical App ID**:
The App ID Steam names inside a storefront response when it maps the requested App ID to a different
store product. The requested App ID remains the Game's identity; the Canonical App ID is retained
only in the raw payload.
_Avoid_: returned App ID, mapped App ID

**Canonical Mapping**:
A storefront response in which the requested App ID resolves to a different Canonical App ID.
game-cat stores the response under the requested App ID.
_Avoid_: alias mapping, redirect

**Library**:
The set of Games game-cat knows about for the Steam account: owned Games plus Games evidenced only by local Steam files. Ownership is a property of a Game, not a precondition for appearing in the Library.
_Avoid_: collection, catalog

**Account**:
The Steam account whose local Steam files and owned-games roster game-cat reads. One Account is bound per data directory; switching Accounts requires a new data directory.
_Avoid_: user, login

**Ownership**:
A Game's relationship to the Steam account: `owned` when the Steam Web API roster confirms it, `local_only` when an install or `localconfig` entry exists but the roster does not confirm it, or `unknown` when the only evidence is Steam Collection membership and no conclusive roster has completed. After a conclusive roster, a Collection-only Game absent from it is `local_only`. Ownership is one property of a Library Game, not the definition of the Library.
_Avoid_: license, entitlement

**Steam Collection**:
A grouping of Games persisted by Steam itself, locally cached in Steam's cloud-storage JSON. Includes user collections, Favorites, and Hidden. game-cat reads Steam Collections in v1 but never writes them.
_Avoid_: Steam category, tag

**Legacy Category**:
A per-app grouping from Steam's pre-2019 model, stored in `sharedconfig.vdf`. game-cat does not use Legacy Categories.
_Avoid_: category, Steam category

**Smart Collection**:
A named, persisted set of Rules owned by game-cat. Membership is computed by evaluating the Rules, not stored game by game.
_Avoid_: filter, saved search, category

**Rule**:
A single predicate over a Game, made of a Prefix, a Field, an Operator, and a Value.
_Avoid_: filter, condition

**Prefix**:
The logical role of a Rule inside its Smart Collection: AND, OR, or NOT.
_Avoid_: mode, operator

**Field**:
A Game attribute that a Rule tests.
_Avoid_: column, property

**Operator**:
The comparison a Rule applies between a Field and a Value.
_Avoid_: predicate

**Value**:
The literal a Rule compares a Field against. Its type is defined by the Field's operator set.
_Avoid_: operand

**Tag**:
A community-assigned descriptor for a Game, with a vote count. Sourced from SteamSpy in v1.
_Avoid_: label, genre

**Genre**:
A Steam storefront genre label for a Game, such as Action or Adventure, stored in `genres_json`. Storefront metadata, not a Tag.
_Avoid_: tag, category

**Storefront Category**:
A Steam storefront feature label for a Game, such as Single-player or Steam Achievements, stored in `categories_json`. Storefront metadata, not a Steam Collection.
_Avoid_: category, Steam category, collection

**Storefront Type**:
The storefront's product type for a Game, such as `game`, `dlc`, or `demo`. The Rule Field is
`storefrontType`; null means unknown.
_Avoid_: bare type as a Rule Field

**Release Year**:
The storefront's release year for a Game. A v1 Field; null means unknown.
_Avoid_: release date

**Metacritic Score**:
The storefront's Metacritic score for a Game, 0-100. A v1 Field; null means unknown.
_Avoid_: rating, review score

**Platform**:
A storefront-supported platform for a Game, such as Windows, macOS, or Linux. A v1 multi-valued Field.
_Avoid_: OS

**Developer**:
A storefront-listed developer for a Game. A v1 multi-valued Field.
_Avoid_: studio

**Publisher**:
A storefront-listed publisher for a Game. A v1 multi-valued Field.
_Avoid_: studio

**Metadata**:
Game attributes fetched from external sources and cached by game-cat, such as Tags, Genres, storefront details, and review summaries. Missing Metadata never hides a Game. Fetched at runtime and never redistributed.
_Avoid_: enrichment, sync, scrape

**Cover Art**:
The capsule, header, and library images the Steam storefront serves for a Game. game-cat fetches Cover Art at runtime and never redistributes it.
_Avoid_: image, thumbnail, artwork

**Refresh**:
A run that reads Steam or external Metadata sources and updates game-cat's stored data. Scopes are `library`, `ownership`, `metadata`, and `all`; the metadata phase runs in Fetch or Full Refresh mode.
_Avoid_: sync, sync job

**Fetch**:
A Refresh mode that requests only Metadata sources with no usable current data: a source with no row, a never-attempted missing value, or a stale or failed value. It skips sources that are already `ok`, settled missing, or `unavailable`.
_Avoid_: sync, update

**Pending**:
A Metadata source state for a Game on the Refresh-errors view: no row, or `missing` with no `*_fetched_at`, so the source has not attempted it yet. This is narrower than Fetch's pending set: Fetch also treats `stale` and `error` as pending work, while `/errors` reports those as Affected instead.
_Avoid_: failed, affected

**Affected**:
A Game that the Refresh-errors view counts for a Metadata source because its last attempt failed: `stale` or `error`. Pending and settled `missing` are never affected.
_Avoid_: pending, broken

**Full Refresh**:
A Refresh mode that re-requests all three Metadata sources for an explicit selection of Games, even when the stored data is current. It is only available for selected Games.
_Avoid_: sync all, force refresh

**Playtime**:
Total time a Game has been played, as recorded by Steam.
_Avoid_: hours

**Last Played**:
The most recent time a Game was played, as recorded by Steam. A v1 Field; null means never played or not yet known.
_Avoid_: recent playtime

**Review Score**:
The percentage of positive user reviews in Steam's review summary, 0-100. A v1 Field; null when the Game has no usable review summary.
_Avoid_: rating, userscore

**Review Tier**:
Steam's official user-review label, such as Very Positive or Mixed. A v1 Field.
_Avoid_: review rating, review label

**Review Count**:
The total number of user reviews in Steam's review summary. A v1 Field; `0` is a known no-review
Game and null is unknown.
_Avoid_: total reviews, review total

**Review Status**:
The last review-summary fetch state for a Game: `ok`, `unavailable`, `missing`, `stale`, or
`error`.
_Avoid_: review state

**Installed**:
Whether a Game's content is present on the local disk, derived from Steam's app manifest.

**HLTB Time**:
A How Long To Beat completion estimate for a Game. A v2 Field.

**v1 / v2 / v3 / v4**:
v1 reads the local library and evaluates Smart Collections over it. v2 adds HLTB Time. v3 adds writing Steam Collections back. v4 wraps the app as a desktop application.
