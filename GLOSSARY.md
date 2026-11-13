# game-cat

Game-cat is a local, read-first view of a Steam library: it reads what Steam already knows, adds metadata Steam does not surface well, and lets the user build reusable views over it.

## Language

**Game**:
An entry in the user's Steam library, identified by its Steam App ID. A Game exists whether or not it is installed.
_Avoid_: title, app

**Library**:
The set of Games owned by the Steam account game-cat is reading.
_Avoid_: collection, catalog

**Steam Category**:
A grouping of Games persisted by Steam itself in its local configuration. game-cat reads Steam Categories in v1 but never writes them.
_Avoid_: Steam collection, tag

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

**Tag**:
A community-assigned descriptor for a Game, with a vote count. Sourced from SteamSpy in v1.
_Avoid_: label, genre

**Enrichment**:
Metadata about Games that comes from outside the local Steam installation and is cached by game-cat.
_Avoid_: sync, scrape

**Playtime**:
Total time a Game has been played, as recorded by Steam.
_Avoid_: hours

**Installed**:
Whether a Game's content is present on the local disk, derived from Steam's app manifest.

**HLTB Time**:
A How Long To Beat completion estimate for a Game. A v2 Field.

**v1 / v2 / v3 / v4**:
v1 reads the local library and filters it with Smart Collections. v2 adds HLTB Time. v3 adds writing Steam Categories back. v4 wraps the app as a desktop application.
