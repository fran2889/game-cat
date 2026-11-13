# Steam metadata sources: the v1 enrichment contract

- Ticket: [#5 Steam metadata contract: SteamSpy and storefront](https://github.com/fran2889/game-cat/issues/5)
- Live checks: **2026-11-13, 17:47-17:51 UTC**
- Scope: game-cat v1. Where Tags and canonical Game metadata come from, and how game-cat talks to those sources.

## Recommendation in one page

Two keyless sources, each with one job:

| Source | Supplies | Why the other source cannot |
| --- | --- | --- |
| **SteamSpy** `appdetails` | `Tags` with vote counts, review counts, owners range, CCU, playtime medians/averages, languages | Steam's storefront `appdetails` returns no tags |
| **Steam storefront** `appdetails` | Name, developers, publishers, genres, categories, release date, Metacritic, platforms, price, `type` | SteamSpy has no release date, platforms, categories, or Metacritic |

No third source is needed for any v1 Field. (Review score, not a v1 Field, would use Steam's `appreviews` endpoint.)

The contract, in one line: **one request per App ID to each source, serial per host (storefront <= 200 requests / 5 min; SteamSpy <= 1 request / second), `cc=us&l=english` pinned on the storefront, cache for 7 days, keep last-known-good, and never drop a Game because enrichment is missing.**

Two live findings drive the design:

1. **The storefront cannot batch canonical metadata (in the tested combinations).** Multi-App-ID requests only succeeded with `filters=price_overview`; `filters=basic`, `filters=genres`, and `basic,genres` returned `HTTP 400` with body `null`. Canonical metadata is one request per App.
2. **SteamSpy's bulk `all` feed no longer carries tags.** All 1,000 records on `request=all&page=0` had no `tags`, `genre`, or `languages`. Tags exist only in per-App `appdetails`.

The storefront is therefore the slower source in practice: ~40 Apps/minute against SteamSpy's ~60 Apps/minute.

## How this was verified

The sandbox initially blocked egress to both hosts. It opened during the session; every sample and header below is from a live response on **2026-11-13** between 17:47 and 17:51 UTC, requested serially with 2 s spacing. ~14 requests total.

| Check | Result |
| --- | --- |
| SteamSpy `appdetails` for 730, 570, 620, 999999999, 224060 | `200`, full records; unknown App returns a zeroed record |
| SteamSpy `all&page=0` | `200`, exactly 1,000 records, **no `tags`/`genre`/`languages`** |
| Storefront single App (730, 620, 570) | `200`, full and filtered payloads |
| Storefront batch, no filters | `400`, body `null` |
| Storefront batch, `filters=basic` / `genres` / `basic,genres` | `400`, body `null` |
| Storefront batch, `filters=price_overview` | `200`, `data: []` for free Apps |
| Storefront delisted 224060 | `200`, `{"224060":{"success":false}}` |
| Storefront invalid 999999999 | `200`, `{"999999999":{"success":false}}` |
| Rate limits | **Not probed.** No 429 seen in this small paced run; the numbers below come from clients and prior art |
| SteamSpy terms | **Not retrieved.** See [Limits and terms](#steamspy-limits-and-terms) |

No API keys exist for either source, so none are used or stored.

## SteamSpy `appdetails`

### Endpoint

```
GET https://steamspy.com/api.php?request=appdetails&appid=<appid>
```

- Keyless, public, JSON, `GET`.
- **One App ID per request.** There is no multi-App-ID form.
- Sibling requests: `all&page=N` (1,000 Games/page), `genre`, `tag`, `top100in2weeks`, `top100forever`, `top100owned`. Index: <https://steamspy.com/api.php>.
- SteamSpy is an independent third party, not Valve. It aggregates public Steam profiles and store data.

### Live sample (trimmed)

`GET .../api.php?request=appdetails&appid=730`, 2026-11-13 17:48 UTC. Tags trimmed to 10 of 20; languages shortened:

```json
{
  "appid": 730,
  "name": "Counter-Strike: Global Offensive",
  "developer": "Valve",
  "publisher": "Valve",
  "score_rank": 93,
  "positive": 8559172,
  "negative": 1422258,
  "userscore": 85,
  "owners": "200,000,000 .. 500,000,000",
  "average_forever": 34750,
  "average_2weeks": 675,
  "median_forever": 8518,
  "median_2weeks": 302,
  "price": "0",
  "initialprice": "0",
  "discount": "0",
  "ccu": 1107090,
  "languages": "English, Czech, Danish, Dutch, Finnish, French, ...",
  "genre": "Action, Free To Play",
  "tags": {
    "FPS": 92858,
    "Shooter": 66748,
    "Multiplayer": 63661,
    "Competitive": 54518,
    "Action": 48294,
    "Team-Based": 47161,
    "e-sports": 44427,
    "Tactical": 42072,
    "First-Person": 40094,
    "PvP": 35155
  }
}
```

The name is stale: the storefront says **Counter-Strike 2**, SteamSpy still says *Counter-Strike: Global Offensive*. This is the concrete case for storefront-first naming.

### Fields worth using

| Field | Type | Use | Notes |
| --- | --- | --- | --- |
| `appid` | int | identity | Echoes the requested App ID; a mismatch means the response is not usable |
| `name` | string | fallback display name | Lags renames (730 above). Prefer the storefront |
| `developer` | string | fallback | **Comma-separated string**, not an array |
| `publisher` | string | fallback | Same caveat |
| `genre` | string | fallback / comparison | Comma-separated; includes `Free To Play`. Storefront genres are structured |
| `tags` | object `string -> int` | **only Tag source** | Name -> vote count. 20 Tags observed on every populated App. Treat order as unspecified (live 730 was descending; the 2018 payload was not); sort client-side. The live miss returned `[]`; accept `[]` and `{}` defensively |
| `positive`, `negative` | int | review counts | Counts, not a score |
| `userscore` | int 0-100 | **do not use** | Inconsistent: 730 -> 85, 570 -> 0 despite 2,037,143 positive reviews. Not a Metacritic equivalent |
| `owners` | string range | approximate popularity | Bucket, never an exact count |
| `ccu` | int | popularity snapshot | Point-in-time |
| `average_forever`, `median_forever` | int (minutes) | population playtime comparison | Local Steam playtime wins for the user's own Games |
| `average_2weeks`, `median_2weeks` | int (minutes) | recent activity | Often 0 |
| `price`, `initialprice`, `discount` | string | — | Cents and percent as strings. Use storefront `price_overview` if price matters |
| `languages` | string | language filter | Comma-separated, no HTML (unlike storefront) |
| `score_rank` | string | **do not use** | `93`, `100`, or `""` in the live samples; semantics undocumented |

SteamSpy does **not** provide release date, platforms, categories, Metacritic, images, or structured developer/publisher arrays.

### Missing Apps: the live shape

An App ID SteamSpy does not know returns **HTTP 200 with a full, zeroed record** that echoes the requested ID. Requesting `999999999` returned:

```json
{
  "appid": 999999999,
  "name": null,
  "developer": "",
  "publisher": "",
  "score_rank": "",
  "positive": 0,
  "negative": 0,
  "userscore": 0,
  "owners": "0 .. 20,000",
  "average_forever": 0,
  "average_2weeks": 0,
  "median_forever": 0,
  "median_2weeks": 0,
  "price": null,
  "initialprice": null,
  "discount": null,
  "ccu": 0,
  "languages": null,
  "genre": null,
  "tags": []
}
```

Classifier for "no SteamSpy data": `name == null` **or** `tags` empty **or** `appid` mismatch. A `999999` sentinel (used by Fran's prior art) did **not** occur in any live response; keep handling it defensively but do not depend on it.

### Delisted Apps

Live 224060 (*Deadpool*, delisted from the storefront) still returns a full SteamSpy record with 20 tags and 3,369 positive reviews. This is the reason SteamSpy is also the tag source for delisted Games.

### The `all` feed no longer helps with tags

`GET ...?request=all&page=0` returned exactly 1,000 records, but **0 of 1,000** had `tags`, `genre`, or `languages`. They carry only summary fields (`appid`, `name`, `developer`, `publisher`, `positive`, `negative`, `owners`, playtime, price, `ccu`, `score_rank`). Do not design a tag bootstrap around `all`. Tags require one `appdetails` call per App.

### Headers and caching

Live response headers for `appdetails`:

```
content-type: application/json
server: cloudflare
cache-control: max-age=86400
cf-cache-status: HIT
age: 3361
last-modified: Fri, 13 Nov 2026 17:47:58 GMT
vary: Accept-Encoding
```

- SteamSpy serves through Cloudflare with a **1-day shared cache**.
- No `ETag`; the `Last-Modified` value tracked the cache entry, not a content revision. Do not build conditional requests on it.
- A 7-day local TTL is safe and avoids re-fetching unchanged daily aggregates.

### SteamSpy limits and terms

- **No API key, no registration.**
- **Documented poll rate.** SteamSpy's API page has historically stated an allowed rate; the `node-steamspy` README quotes it as **"Allowed poll rate - 4 requests per second"** (<https://github.com/keyCat/node-steamspy>). That quotation is old.
- **Current practice is slower.** `steamspypi` documents `request=all` at **1 request/minute** with 1,000 Games/page (<https://github.com/woctezuma/steamspypi>). Recent scrapers and prior art use **1 request/second** for `appdetails` and report `429` / `"Too many connections"` when bursting.
- **Contract:** 1 req/s for `appdetails`, 1 req/min for `all`. Never approach 4 req/s.
- **Terms: unresolved.** No licence or terms text was retrievable. Attribute SteamSpy, cache locally, do not redistribute bulk data, and re-check its terms before commercial distribution. This is a known gap, not a legal conclusion.

## Steam storefront `appdetails`

### Endpoint

```
GET https://store.steampowered.com/api/appdetails?appids=<id>&cc=us&l=english&filters=<sections>
```

- Keyless, public, JSON, `GET`.
- **Undocumented by Valve.** It is the endpoint the store frontend uses; it is not part of the documented Steam Web API (`ISteamApps`, etc., <https://partner.steamgames.com/doc/webapi_overview>). Stable in practice, unpromised in principle.
- The response is always an object keyed by App ID string: `{"620": {"success": true, "data": {...}}}`.
- `cc` selects country/currency and availability. **Pin it** (`cc=us`); otherwise Steam generally derives it from the caller's IP. The archived 620 payload from 2020 came back in EUR; the live `cc=us` payload is USD.
- `l` selects language. Pin `l=english`.
- `filters` returns only the named top-level sections, plus whatever `basic` implies. A single-App request with `filters=basic,developers,publishers,genres,categories,release_date,metacritic,platforms` returned a 2.1 KB payload for 730 instead of 18.8 KB unfiltered.
- **Multiple App IDs only worked with `filters=price_overview` in testing.** See [Batching is price-only](#batching-is-price-only).

### Live sample (trimmed)

`GET .../appdetails?appids=620&cc=us&l=english`, 2026-11-13 17:49 UTC. Descriptions, requirements, screenshots, movies, packages removed:

```json
{
  "620": {
    "success": true,
    "data": {
      "type": "game",
      "name": "Portal 2",
      "steam_appid": 620,
      "required_age": 0,
      "is_free": false,
      "controller_support": "full",
      "developers": ["Valve"],
      "publishers": ["Valve"],
      "platforms": { "windows": true, "mac": false, "linux": true },
      "metacritic": {
        "score": 95,
        "url": "https://www.metacritic.com/game/pc/portal-2?ftag=MCD-06-10aaa1f"
      },
      "genres": [
        { "id": "1", "description": "Action" },
        { "id": "25", "description": "Adventure" }
      ],
      "categories": [
        { "id": 2, "description": "Single-player" },
        { "id": 1, "description": "Multi-player" },
        { "id": 9, "description": "Co-op" },
        { "id": 38, "description": "Online Co-op" },
        { "id": 39, "description": "Shared/Split Screen Co-op" },
        { "id": 22, "description": "Steam Achievements" }
      ],
      "release_date": { "coming_soon": false, "date": "Apr 18, 2011" },
      "recommendations": { "total": 393025 },
      "price_overview": {
        "currency": "USD",
        "initial": 999,
        "final": 999,
        "discount_percent": 0,
        "final_formatted": "$9.99"
      },
      "supported_languages": "English<strong>*</strong>, French<strong>*</strong>, ...",
      "content_descriptors": { "ids": [], "notes": null }
    }
  }
}
```

### Status semantics (live)

```
{ "620":       { "success": true,  "data": { ... } } }
{ "224060":    { "success": false } }   // delisted
{ "999999999": { "success": false } }   // invalid
```

- Both delisted and invalid App IDs return **HTTP 200** with `success: false` and the key present. There is no error status and no reason code.
- `success: false` means unavailable: delisted, region-blocked, or not a store product. It cannot distinguish them, so the UI should say "not available on the store", not "delisted".
- A missing key, `success: false`, or `data: null`/`{}` all mean "no storefront metadata". `data` can be an empty array in price-only batch responses.

### Fields worth using

| Field | Type | Use | Notes |
| --- | --- | --- | --- |
| `steam_appid` | int | identity | Must equal the requested ID |
| `type` | string | classification | `game`, `dlc`, `demo`, `application`, `tool`, ... Record it; do not assume `game` |
| `name` | string | **canonical display name** | Live 730 is *Counter-Strike 2* while SteamSpy still says *Global Offensive* |
| `is_free` | bool | filter | |
| `developers`, `publishers` | array of string | **canonical** | Requires the `developers`/`publishers` filters (not included by `basic`) |
| `genres` | array `{id: string, description}` | **canonical genres** | `id` is a numeric string, unlike category ids |
| `categories` | array `{id: int, description}` | Steam features | Single-player, Co-op, Workshop, Cloud, controller support, ... Dedupe by `id`; labels can repeat (ids 30 and 51 are both "Steam Workshop") |
| `release_date` | `{coming_soon: bool, date: string}` | release year | **Localised free text.** Live `cc=us` gives `"Apr 18, 2011"`; a 2020 EUR capture gave `"18 Apr, 2011"`. `"Coming soon"`, `"TBA"`, or a bare year occur. Store raw; parse defensively; never sort the string |
| `metacritic` | `{score: int, url: string}` or `null` | critic score | Live 730 has `null`; 620/570 have values. Not a user score |
| `platforms` | `{windows, mac, linux}` bools | platform filter | |
| `recommendations.total` | int | review count | Absent when reviews are not enabled |
| `price_overview` | object or `null` | price | Cents + currency; `null` for free Apps. Currency follows `cc` |
| `controller_support` | string | filter | `"full"` or absent |
| `supported_languages` | string | language filter | Contains HTML `<strong>*</strong>` markers; strip tags |
| `content_descriptors` | `{ids, notes}` | maturity filter | Live 730: `ids: [2, 5]`, with a note |
| `required_age` | int | maturity filter | 0 when unrated |

The storefront does **not** return tags, nor a normalised release year.

### Batching is price-only

This is the most important operational finding. With `appids=730,570`:

| Query | Result |
| --- | --- |
| no `filters` | `400 Bad Request`, body `null` |
| `filters=basic` | `400`, body `null` |
| `filters=genres` | `400`, body `null` |
| `filters=basic,genres` | `400`, body `null` |
| `filters=price_overview` | `200`, `{"730":{"success":true,"data":[]},"570":{"success":true,"data":[]}}` (free Apps) |

Single-App requests accept all of those filters normally (e.g. `filters=genres,categories` returns just those two sections; `filters=basic,...` adds the basic block).

**Consequence:** there is no way to fetch genres/categories/release/Metacritic/platforms for several Apps in one request. Do not build a 50-App batch for canonical metadata. Batch only if a future price sync needs it, and expect `data: []` for free Apps.

### Headers and caching

Live response headers for a successful single-App request:

```
Server: nginx
Content-Type: application/json; charset=utf-8
Cache-Control: public,max-age=3600
Expires: Fri, 13 Nov 2026 17:51:11 GMT
Last-Modified: Fri, 13 Nov 2026 16:00:00 GMT
Vary: origin
```

- `Cache-Control` says **1 hour**; `Expires` was only ~3 minutes after the response, so the two disagree. Trust `max-age=3600`.
- No `ETag`. `Last-Modified` sat at the top of the hour, not at a content revision; do not rely on conditional requests.
- A 7-day local TTL for near-static metadata is fine; 24 hours for `price_overview` if it is ever stored.

### Limits

- **200 requests / 5 minutes per IP** (~1 every 1.5 s). Not in Valve's docs; used by `node-steamapi` ("Requests for this endpoint are limited to 200 every 5 minutes"), `FronkonGames/Steam-Games-Scraper` ("200 requests in five minutes ... one request every 1.5 seconds"), and Fran's prior art (`RateLimiter.create(200.0 / 300.0)`).
- The limit is per IP, not per key. A shared/NAT IP may already be spending budget.
- No 429 was observed in this run; honour `Retry-After` if one appears. A `403` is a block/challenge: stop the source and back off.

## Coverage matrix

| Situation | SteamSpy | Storefront | game-cat behaviour |
| --- | --- | --- | --- |
| Both have data | tags + counts | full metadata | normal enrichment |
| SteamSpy missing/hidden | zeroed record, `name: null`, `tags: []` | full metadata | keep the Game, `tags_status = missing`, show "no tags" (distinct from zero Tags); retry next cycle |
| Delisted from storefront | still has tags (live 224060: 20) | `success: false` | keep the Game, `store_status = unavailable`, retain last-known-good store metadata, keep using tags; do not hide it |
| New Game, store only | missing | full metadata | store metadata first; tags appear later |
| Both missing | zeroed record | `success: false`/missing | keep the Game from local Steam files; surface "metadata unavailable"; the local name still renders |
| Rate-limited/offline | 429/5xx | 429/5xx | keep cached values, mark `stale`, resume later; browsing never blocks |

The local Steam library is the source of truth for which Games exist. Enrichment must never delete or hide a Game.

## Third source?

For **v1 Fields: no**. Tags come only from SteamSpy; every other v1 Field comes from the storefront or local Steam files.

Fields that would need a third source if added later (all out of scope for v1):

| Future Field | Source | Notes |
| --- | --- | --- |
| Review score ("Very Positive") | `https://store.steampowered.com/appreviews/<appid>?json=1&num_per_page=0&language=all&purchase_type=all` | Keyless, same host and rate-limit family; returns `query_summary.review_score_desc`, `total_positive`, `total_negative`, `total_reviews`. Used by Fran's prior art |
| Steam Deck compatibility | Store compatibility report / app page | Undocumented, fragile; not needed for v1 |
| HLTB Time | HLTB (v2 ticket) | Separate enrichment, separate source |

There is no acceptable tag fallback in v1. Scraping the store page's tag markup would be brittle and not clearly permitted; show "no tags" for the Apps SteamSpy misses.

## Recommended v1 sync contract

### Requests

```http
GET https://steamspy.com/api.php?request=appdetails&appid=<appid>
GET https://store.steampowered.com/api/appdetails?appids=<appid>&cc=us&l=english&filters=basic,developers,publishers,genres,categories,release_date,metacritic,platforms
```

- **One App ID per request to each source.** No storefront metadata batching.
- SteamSpy response is a flat object. Storefront response is keyed by App ID and needs the `success` check.
- User-Agent: a descriptive, honest string such as `game-cat/<version> (local Steam library app)`. Do not impersonate a browser.
- SteamSpy: 1 request/second, strictly serial. Storefront: <= 200 requests / 5 minutes, strictly serial. The two hosts have independent budgets; the two passes may run concurrently, each serial against its own host.

### Scheduling

1. Read App IDs from local Steam files. **Serve cached enrichment immediately**; sync is background work.
2. Storefront and SteamSpy passes can run in parallel. Persist each App's result as it lands.
3. Storefront fills name/developers/publishers/genres/categories/release/Metacritic/platforms.
4. SteamSpy fills tags, review counts, owners, CCU, playtime, languages.
5. The sync is resumable and idempotent; a crash loses at most the in-flight request.
6. Never block the UI. Expose per-source status (`ok`, `partial`, `rate_limited`, `offline`) and a last-success timestamp.

### Budgets

Storefront at 200 requests / 5 min = 40 requests/min; SteamSpy at 1 request/s = 60 requests/min.

| Library size | Storefront (serial) | SteamSpy (serial) | Both in parallel |
| --- | --- | --- | --- |
| 500 Games | 12.5 min | 8.3 min | ~13 min |
| 1,000 Games | 25 min | 16.7 min | ~25 min |
| 5,000 Games | 2.1 h | 1.4 h | ~2.1 h |
| 10,000 Games | 4.2 h | 2.8 h | ~4.2 h |

A first full sync of a 1,000-Game library is a ~25-minute background job, not a page load. Design the UI for progressive filling, not a spinner.

### TTLs

| Data | TTL | Rationale |
| --- | --- | --- |
| SteamSpy tags/review counts | 7 days | Upstream aggregates change slowly; SteamSpy's CDN caches 1 day |
| Storefront metadata | 7 days | Names/genres/release dates are near-static |
| Storefront `price_overview` (if stored) | 24 hours | Prices change with sales; Steam's CDN says 1 hour |
| SteamSpy miss (`name: null`) | 24 hours | New Games appear; retry cheaply |
| Storefront `success:false` | 30 days | Delisting is rare; re-check monthly |
| Manual refresh | bypasses TTL for selected Games | User-initiated |

### Retry, backoff, circuit breaking

| Response | Action |
| --- | --- |
| `429` | Honour `Retry-After`; otherwise exponential backoff with full jitter, base 2 s, factor 2, cap 60 s, max 5 attempts. Pause the whole source, not just the request |
| `403` | Block/challenge. Do not retry quickly. Stop the source for 15 minutes, surface `rate_limited/blocked`, resume next cycle |
| `400` (storefront) | Request-shape bug, not transient. Fix the query; do **not** retry. A `400` with body `null` is the signature of an unsupported batch filter |
| `5xx`, timeout, reset | Retry with jitter, max 5 attempts; mark `stale`, continue with the next App |
| Other `4xx` | No retry. Record the status and continue |
| `200` + `success:false` | Not an error. Record `unavailable`; no immediate retry |
| 5 consecutive failures | Open the circuit for that source for 15 minutes; keep serving cache |

Do not parallelise within a source. One in-flight request per host is enough at these budgets.

### What to persist

One enrichment row per App, keyed by `appid`:

```
appid                 INTEGER PRIMARY KEY
tags_json             TEXT      -- [{"name": "...", "votes": 123}, ...] sorted desc
tags_status           TEXT      -- ok | missing | stale | error
tags_fetched_at       TEXT
store_status          TEXT      -- ok | unavailable | error | stale
store_fetched_at      TEXT
name                  TEXT      -- storefront, else SteamSpy, else local manifest
type                  TEXT
developers_json       TEXT
publishers_json       TEXT
genres_json           TEXT
categories_json       TEXT
release_date_raw      TEXT      -- exact localised string
release_year          INTEGER   -- parsed; NULL when unparseable
metacritic_score      INTEGER
platforms_json        TEXT      -- {"windows":true,"mac":true,"linux":true}
raw_steamspy_json     TEXT      -- keep raw for forward compatibility
raw_store_json        TEXT
```

Keep raw payloads; fields get added and re-fetching is expensive. Normalise only the Fields Rules filter on.

### Field precedence

| Field | First choice | Fallback |
| --- | --- | --- |
| Name | Storefront `name` (live: *Counter-Strike 2*) | SteamSpy `name` (live: *Counter-Strike: Global Offensive*) -> local appmanifest |
| Developers / publishers | Storefront arrays | SteamSpy comma string split on `, ` |
| Genres | Storefront objects | SteamSpy `genre` split on `, ` |
| Release year | Storefront `release_date.date` parsed | `NULL` |
| Metacritic / platforms / categories | Storefront | `NULL` |
| Tags | SteamSpy `tags` | none (explicit "no tags") |
| Playtime | Local Steam data | SteamSpy medians/averages as a population comparison |

### Parsing release dates

`release_date.date` is a display string, not a date, and its format follows `cc`/`l`. Accept at least:

- `"Apr 18, 2011"` (live `cc=us`)
- `"18 Apr, 2011"` (EU-style capture)
- `"2014"` (year only)
- `"Coming soon"`, `"TBA"`, `"To be announced"`

Extract a year into `release_year`; keep the raw string. Sorting on the raw string is wrong (`"Apr..."` < `"Jul..."` incidentally works, but `"18 Apr..."` does not).

## Open questions and what to verify later

1. SteamSpy's current API page: exact poll rate, terms, and whether `appdetails` is still 1/s.
2. SteamSpy `userscore` semantics: why 570 returns 0 with 2M positive reviews. Treat as unusable until explained.
3. SteamSpy tag cap: 20 observed on all populated Apps; is it hard?
4. Storefront rate limit: confirm the 200/5 min enforcement and capture a real 429 + `Retry-After`.
5. Whether any future storefront filter combination enables metadata batching. Today it is price-only.
6. Whether `all` ever regains tags; today it is summary-only.
7. SteamSpy terms/licence for redistribution.
8. Age-gated Apps with `cc=us&l=english`: confirm `success:true` and `required_age` semantics (not tested here).

## Sources

Primary endpoints and docs:

- SteamSpy API index: <https://steamspy.com/api.php>
- SteamSpy site: <https://steamspy.com/>
- Steam storefront `appdetails`: <https://store.steampowered.com/api/appdetails?appids=730&cc=us&l=english>
- Steam Web API overview (the storefront endpoint is not part of it): <https://partner.steamgames.com/doc/webapi_overview>

Client documentation and corroboration:

- `node-steamapi` (storefront 200/5 min, batch/`filters`, `success` handling): <https://github.com/xDimGG/node-steamapi>, `src/SteamAPI.ts`, `getGameDetails`
- `node-steamspy` (quotes SteamSpy's "Allowed poll rate - 4 requests per second"): <https://github.com/keyCat/node-steamspy>
- `steamspypi` (`all` pagination, 1,000/page, 1 request/minute): <https://github.com/woctezuma/steamspypi>
- `FronkonGames/Steam-Games-Scraper` (storefront 200 requests / 5 minutes, 1.5 s spacing): <https://github.com/FronkonGames/Steam-Games-Scraper>
- `steamstore` Python wrapper (field inventory): <https://github.com/saucesteals/steamstore>

Prior art (behaviour to preserve, not a spec):

- `fran2889/steam-cat`: `SteamSpyAppDetails.APP_HIDDEN`, `SteamSpyClient`, `StorefrontApiClient`, `MetadataRefreshWorker`, `RateLimiter.create(200.0 / 300.0)`.

Archived payloads used only for the date-format comparison and the earlier shape check:

- Storefront 620 in EUR: `quer/steam-store-ripoff`, `620.json`, last pushed 2020-10-19: <https://github.com/quer/steam-store-ripoff>
- SteamSpy 2018 tag ordering: `tsktp/bigdataboys`, `src/main/resources/json_files/730.json`, last pushed 2018-12-11: <https://github.com/tsktp/bigdataboys>

## Live verification log (2026-11-13 UTC)

| Time | Request | Status | Note |
| --- | --- | --- | --- |
| 17:48:04 | SteamSpy `appdetails&appid=730` | 200 | 1,075 B; `cf-cache-status: HIT`, `age: 3361` |
| 17:48:0x | SteamSpy `appdetails&appid=570` | 200 | 1,054 B; `userscore: 0` |
| 17:48:0x | SteamSpy `appdetails&appid=620` | 200 | 1,033 B |
| 17:48:0x | SteamSpy `appdetails&appid=999999999` | 200 | 313 B; zeroed record |
| 17:48:26 | Storefront `appids=730&cc=us&l=english` | 200 | 18,786 B; `Cache-Control: public,max-age=3600` |
| 17:48:39 | Storefront batch `730,570` + multi-filter | 400 | body `null` |
| 17:48:4x | Storefront batch `730,570` no filters | 400 | body `null` |
| 17:48:4x | Storefront batch `730,570&filters=price_overview` | 200 | `data: []` for both free Apps |
| 17:48:5x | Storefront batch `730,570&filters=basic` | 400 | body `null` |
| 17:49:0x | Storefront `appids=730` + filters (`basic` ... ) | 200 | 2,142 B; dev/pub present |
| 17:49:0x | Storefront `appids=620` | 200 | 5,561 B |
| 17:49:0x | Storefront `appids=224060` (delisted) | 200 | `{"224060":{"success":false}}` |
| 17:49:0x | Storefront `appids=999999999` (invalid) | 200 | `{"999999999":{"success":false}}` |
| 17:49:0x | SteamSpy `appdetails&appid=224060` (delisted) | 200 | 470 B; 20 tags retained |
| 17:50:05 | SteamSpy `all&page=0` | 200 | 1,000 records; **no tags/genre/languages** |

Reproduction commands:

```sh
curl -sS --compressed -D - \
  "https://steamspy.com/api.php?request=appdetails&appid=730"

curl -sS --compressed -D - \
  "https://store.steampowered.com/api/appdetails?appids=730&cc=us&l=english&filters=basic,developers,publishers,genres,categories,release_date,metacritic,platforms"

# Batch metadata is expected to fail; keep this out of the client.
curl -sS --compressed -i \
  "https://store.steampowered.com/api/appdetails?appids=730,570&cc=us&l=english&filters=genres"
```
