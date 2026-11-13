# How Long To Beat as a v2 data source

**Question:** Find a data source for How Long To Beat times that v2 can rely on.

**Checked:** 2026-11-13.

**Verdict:** **GO, conditional.** Use the site's unofficial JSON endpoint through a replaceable adapter, on demand and paced, with long-lived local caching and Steam App ID matching first. Do **not** bulk-scrape, bundle a dataset, or ship HLTB data. If `robots.txt` or the site's terms turn out to forbid programmatic access, this flips to **NO-GO** (see [Open questions](#8-open-questions)).

> Live requests to `howlongtobeat.com` could not be made from the research sandbox: its egress policy returned HTTP 403 `Approval required` for the domain. Everything below about the wire protocol therefore comes from maintained clients that document the current endpoint, plus one recorded HLTB game page. The sample run uses a dated community snapshot as a stand-in corpus. Re-verify the endpoint and `robots.txt` from a normal network before implementing.

## 1. Official API status and terms

There is **no official public API**, and no developer documentation is published that we could find.

- Maintained clients say so explicitly. The Ruby client README: "HowLongToBeat has no official API and rate-limits bursts. Please keep the default pacing." ([dpashutskii/howlongtobeat README](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/README.md))
- The independent API Evangelist profile reaches the same conclusion: "does not publish an official public API; all programmatic access relies on community-built wrappers that query the website directly" ([api-evangelist/howlongtobeat](https://github.com/api-evangelist/howlongtobeat)).
- There is no terms-of-use page we could find. A recorded HLTB page footer links only **Contact Us** (`/feedback`), **Code of Conduct** (`/conduct`) and the **Ziff Davis Privacy Policy**; HLTB is a Ziff Davis property ([recorded page footer](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/spec/fixtures/game_page.html), [Ziff Davis privacy policy](https://www.ziffdavis.com/privacy-policy)). An unrelated research note that checked on 2026-11-02 reports `https://howlongtobeat.com/terms` and `https://www.howlongtobeat.com/terms` both returned 404 ([vukem-hexascore SOURCES.md](https://github.com/AlexGalhardo/vukem-hexascore/blob/main/docs/data/SOURCES.md)).
- `https://howlongtobeat.com/robots.txt` **was not verifiable** here. Attempts from this sandbox were rejected by the sandbox proxy, not by HLTB, so they say nothing about the file's contents. A maintainer must fetch it from an ordinary network and record the result before enabling the feature.

Verification attempts on 2026-11-13: `GET /`, `GET /robots.txt`, `GET /api/s/init?t=…` and `http://howlongtobeat.com` were all rejected by the sandbox's egress proxy with 403 `Approval required` (the plain-HTTP attempt on port 80, the rest on 443), before any request left the sandbox. No HLTB request was made, so no rate-limit budget was consumed.

Practical position: HLTB data is community-contributed but the site and its presentation are Ziff Davis content. No licence for redistribution is offered. Programmatic access is tolerated in practice (multiple widely used OSS clients) but not authorised in writing, and the site actively rate-limits and gates its search endpoint. Treat access as best-effort and personal, not as a data licence.

## 2. The unofficial endpoint

### 2.1 What it is

The website is a Next.js app. Its own search box POSTs JSON to an internal route and gates the call with a short-lived token. That route has been renamed repeatedly:

| When | Route | Evidence |
| --- | --- | --- |
| 2023-07 (npm `howlongtobeat@1.8.0`) | `POST /api/search`, no token | [source](https://github.com/ckatzorke/howlongtobeat/blob/d57da96a95f16ee89959cad8fa30907a0504040f/src/main/hltbsearch.ts) |
| 2026-04-18 | `GET /api/find/init` → `POST /api/find` | field-tested skill notes ([scraping.md](https://github.com/browser-use/desktop/blob/main/app/src/main/hl/stock/domain-skills/howlongtobeat/scraping.md)) |
| 2026-09-26/27 | `/api/bleed` renamed to `/api/search/site`; `/init` also returns `hpKey`/`hpVal` | [steam-hltb-safari investigation](https://github.com/Phishion/steam-hltb-safari/blob/709d706d605d2dc8ec9c234418fe24f4face5170/README.md) |
| 2026-10-02 | current Python client discovers the route from the JS bundle (static `/api/s/` fallback) | [HowLongToBeat.py `HTMLRequests`](https://github.com/ScrappyCocco/HowLongToBeat-PythonAPI/blob/4275a452b9ccd230b7c2a82b8d1a5d851285eb14/howlongtobeatpy/howlongtobeatpy/HTMLRequests.py) |
| 2026-11-04 | Ruby client falls back through `/api/search/site`, `/api/bleed`, `/api/finder`, `/api/search`, `/api/s` | [client.rb](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/lib/howlongtobeat/client.rb) |

**Do not hardcode a single path.** Discover it at runtime from the homepage's `/_next/static/chunks/*.js` bundle: look for a `fetch('/api/...', { ... method: 'POST' ... })` whose options mention `x-auth-token`, keep the **whole** path (`/api/search/site`, not `/api/search`), then cache the result for about an hour. Keep the fallback list above for when discovery fails. The Ruby client is the clearest reference implementation ([client.rb `discover`](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/lib/howlongtobeat/client.rb)).

### 2.2 Request sequence

1. `GET https://howlongtobeat.com/api/<route>/init?t=<epoch-ms>` with `Referer: https://howlongtobeat.com/` (and a browser User-Agent). Response is JSON containing `token` plus a rotating pair whose field names vary; clients read the first name containing `key` as the header key and the first containing `val` as the value:

   ```json
   { "token": "…", "hpKey": "…", "hpVal": "…" }
   ```

   Reuse the token for roughly 60 seconds (Ruby `token_ttl`), and leave ~1 s before the first search (Ruby `token_warmup` 1.2 s).

2. `POST https://howlongtobeat.com/api/<route>` with:

   ```
   Content-Type: application/json
   Origin:   https://howlongtobeat.com
   Referer:  https://howlongtobeat.com/
   User-Agent: <a real browser UA>
   x-auth-token: <token>
   x-hp-key: <key>        # optional, but send it
   x-hp-val: <value>
   ```

   Body (shape accepted by the current Python and game-glance clients):

   ```json
   {
     "searchType": "games",
     "searchTerms": ["the", "witcher", "3"],
     "searchPage": 1,
     "size": 20,
     "searchOptions": {
       "games": {
         "userId": 0, "platform": "", "sortCategory": "popular",
         "rangeCategory": "main", "rangeTime": { "min": 0, "max": 0 },
         "gameplay": { "perspective": "", "flow": "", "genre": "", "difficulty": "" },
         "rangeYear": { "min": "", "max": "" },
         "modifier": "hide_dlc"
       },
       "users": { "sortCategory": "postcount" },
       "lists": { "sortCategory": "follows" },
       "filter": "", "sort": 0, "randomizer": 0
     },
     "useCache": true,
     "<hpKey>": "<hpVal>"
   }
   ```

   References: Python [`get_search_request_data`](https://github.com/ScrappyCocco/HowLongToBeat-PythonAPI/blob/4275a452b9ccd230b7c2a82b8d1a5d851285eb14/howlongtobeatpy/howlongtobeatpy/HTMLRequests.py#L121-L174), game-glance [`fetchSearchResultsWithAuth`](https://github.com/michpalm/game-glance/blob/eb9f14dbec017821f62312441241955da3bd0348/src/vendor/hltb-for-deck/hooks/HltbApi.ts). The current site tolerates minor variations (empty strings vs `0` vs filter objects); keep the payload minimal and mirror what the clients above send.

### 2.3 Search response

```json
{
  "count": 6,
  "pageCurrent": 1,
  "pageTotal": 1,
  "pageSize": 20,
  "data": [
    {
      "game_id": 10270,
      "game_name": "The Witcher 3: Wild Hunt",
      "game_alias": "The Witcher III, Wiedźmin 3: Dziki Gon",
      "game_type": "game",
      "release_world": "2015-05-19",
      "comp_main": 186047,
      "comp_plus": 373542,
      "comp_100": 630981,
      "comp_all": 375859,
      "comp_all_count": 5000,
      "profile_dev": "CD Projekt RED",
      "profile_platform": "PC, PlayStation 4, Xbox One, Nintendo Switch"
    }
  ]
}
```

Field names above are the ones the clients read; the numbers are illustrative. Times are **seconds**; divide by 3600 for hours (Python [`JSONResultParser`](https://github.com/ScrappyCocco/HowLongToBeat-PythonAPI/blob/4275a452b9ccd230b7c2a82b8d1a5d851285eb14/howlongtobeatpy/howlongtobeatpy/JSONResultParser.py)).

- `searchTerms` is a **word array**, not a string.
- `game_type` is `"game"`, `"dlc"`, `"mod"` or `"omit"`; filter or penalise non-games.
- **Search rows do not carry the Steam App ID.** They carry `release_world` (year or date) and platforms. The Ruby client is explicit: "Search rows carry a release year, not a date, and no Steam id; fetch the game page for those." ([records.rb](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/lib/howlongtobeat/records.rb))

### 2.4 Game detail / Steam App ID

`GET https://howlongtobeat.com/game/<game_id>` returns HTML whose `__NEXT_DATA__` script contains the record, including `profile_steam` — the Steam App ID (0 when none). This is one request, no token. Parse `props.pageProps.game.data.game` (an array, but tolerate an object), and use `game_id`, `game_name`, `game_alias`, `release_world`, `profile_steam`, `comp_main`/`comp_plus`/`comp_100`/`comp_all` (seconds). The Ruby client does exactly this ([game_page_parser.rb](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/lib/howlongtobeat/game_page_parser.rb)); its recorded fixture maps HLTB 10270 → `profile_steam: 292030` → "The Witcher 3: Wild Hunt" ([fixture](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/spec/fixtures/game_page.html)).

An alternative is Next's data route `/_next/data/<buildId>/game/<id>.json` — fewer bytes, but it needs the build id scraped from `_ssgManifest.js`/`_buildManifest.js`, and as of 2026-10-02 it returns 403 without a browser User-Agent ([game-glance comment and code](https://github.com/michpalm/game-glance/blob/eb9f14dbec017821f62312441241955da3bd0348/src/vendor/hltb-for-deck/hooks/HltbApi.ts)). The HTML route has no build-id dependency, so prefer it.

## 3. Rate limits, blocking and legal risk

**Documented observations:**

- Ruby client default pacing is **one request every 2 seconds**, with 5 s connect / 10 s read timeouts, and treats HTTP 429 as a distinct `RateLimitedError` ([http.rb](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/lib/howlongtobeat/http.rb)).
- The Python client's own integration tests sleep **3–6 s between tests** "otherwise making them go too fast will return HTTP 429 Too Many Requests" ([conftest.py](https://github.com/ScrappyCocco/HowLongToBeat-PythonAPI/blob/4275a452b9ccd230b7c2a82b8d1a5d851285eb14/howlongtobeatpy/tests/conftest.py)).
- A deliberate burst benchmark saw 429 after roughly **40 request rounds within ~20 s**, recovering after about **one minute**; normal request latency was ~0.23 s p50 over 92 requests ([steam-hltb-safari README](https://github.com/Phishion/steam-hltb-safari/blob/709d706d605d2dc8ec9c234418fe24f4face5170/README.md)).
- Without a browser-like `User-Agent` the detail route returned 403 (2026-10-02 note); without `Referer`, `/init` returned 403 and search 404; cross-origin preflight is rejected (same README). So this must run **server-side** in game-cat's local backend, not from the browser UI.

**Implications for game-cat:**

- Global serial queue, **≥ 2 s between every request**, jittered. Do not parallelise searches for a big library.
- On 429: stop, honour `Retry-After` if present, otherwise back off 60 s and resume; never retry tightly. Ruby's exception split (429 ≠ 404 ≠ parse failure) is the right shape.
- Budget: a first pass over 500 games costs up to 500 searches + 500 detail checks = 1,000 requests ≈ **35 minutes** at 2 s, plus retries. That is acceptable only as a resumable background job; never on page load. Subsequent refreshes at a 30-day TTL touch only stale entries.
- Single-flight per Steam App ID, and cache negative results so absent games are not re-searched every launch.

**Legal/ToS position (not legal advice):** no official API, no published data licence, no `/terms` page. The site gates and rate-limits access, checks `Origin`/`Referer`, and injects a rotating honeypot field — i.e. it is aware of and resists automated clients. Do not defeat access controls, rotate proxies, spoof identities, or redistribute data. Keep the feature personal/local, attribute HLTB and link each game back to its HLTB page, and make it possible to turn the integration off.

## 4. Matching strategy

### 4.1 Order of precedence

1. **Steam App ID (authoritative).** Search by the game's English Steam name, take the top few candidates, fetch each candidate's `/game/<id>` page and compare `profile_steam` to the App ID. On equality, confidence **1.0**; no title/year heuristics needed. This is what game-glance does ("Search by appId first") and what the Ruby fixture demonstrates for appid 292030 → HLTB 10270.
2. **Normalised title + release year (fallback).** Use when no candidate's `profile_steam` matches, the game is a non-Steam shortcut, or the detail fetch fails. Score and threshold as below.
3. **Manual override.** Let the user paste an HLTB URL/ID; persist it keyed by App ID. game-glance already stores `override:hltb:<appid>` ([cache.ts](https://github.com/michpalm/game-glance/blob/eb9f14dbec017821f62312441241955da3bd0348/src/data/cache.ts)).
4. **No match.** Show `—`, never guess, and re-check later. Treat "no match" as a normal state, not an error.

### 4.2 Title normalisation

Apply to both sides before comparing:

- Unicode NFKD, strip combining marks (é→e), strip `™ ® ©`, lowercase.
- `&` → `and`; all punctuation → space; collapse whitespace.
- Drop a leading article (`the`, `a`).
- Generate a **Roman↔Arabic variant** (`III` ↔ `3`) and compare both ways; Steam names use `III` while users and some HLTB rows use `3`.
- Detect **edition suffixes** (`Game of the Year`, `Complete`, `Definitive`, `Remastered`, `Director's Cut`, …). Do not auto-match a base game to an edition (or vice versa) unless the App ID confirms it.
- Query in **English**: Steam's `appdetails?appids=<id>&l=en` returns the canonical English name even when the local client is localised (both game-glance and the Safari userscript do this).

### 4.3 Confidence scoring

Start from `0.55 × title similarity + 0.35 × token containment`, then adjust:

| Signal | Adjustment |
| --- | --- |
| Exact normalised (or roman/arabic) title match | floor at 0.97 |
| Candidate `game_type == "game"` | +0.02 |
| Candidate is DLC/expansion/mod and query is not | −0.50 |
| Release year equals Steam year | +0.08 |
| Release year ±1 | +0.03 |
| Release year differs by more than 1 | −0.10 |
| Edition suffix on candidate but not query | −0.08 |
| Candidate has `comp_main > 0` | +0.03 |
| Candidate has no times (stub/duplicate) | −0.15 |

Clamp to `[0,1]`. Accept bands:

| Score | Action |
| --- | --- |
| App ID match (`profile_steam`) | accept with confidence 1.0 (bypasses scoring) |
| ≥ 0.85 | accept, but only if the candidate is a `game` with at least one time |
| 0.65–0.85 | keep as suggestion; require user confirmation |
| < 0.65 | reject |

Tie-break equal scores by data presence, then `comp_all_count` (sample size), then release year. This matters: HLTB carries duplicate/stub rows with no times (e.g. id 36082 "Witcher 3 Wild Hunt" alongside id 10270).

### 4.4 Request cost of matching

App ID matching needs one detail request **per candidate**, so cap candidates (3–5), order them by the heuristic score, stop at the first `profile_steam` match, and do not fetch details for obvious DLC/mod rows. Once matched, persist `appid → hltb_id` **permanently**, so the expensive path runs once per game ever, not once per cache refresh.

## 5. Sample matching run

Because live HLTB was unreachable, the run uses the **2026-03-27 HLTB snapshot** bundled with [johagan94/hltb-dataset-plugin](https://github.com/johagan94/hltb-dataset-plugin/blob/ee4476326c891976941f17e191096fac7c5dad42/dataset/hltb_dataset.csv) (166,754 rows; `source_url`/`crawled_at` columns) as a stand-in **search-result corpus**. It simulates the title+year fallback exactly as scored above; it does **not** exercise the live `profile_steam` confirmation. The five Steam names/years/appids are the production inputs; "candidates" is how many rows the stand-in search returned.

| Steam App ID | Steam title (year) | HLTB id | HLTB title | Score | Runner-up |
| --- | --- | --- | --- | --- | --- |
| 292030 | The Witcher 3: Wild Hunt (2015) | 10270 | The Witcher 3: Wild Hunt | 1.00 accept | 36082 "Witcher 3 Wild Hunt" 0.84 (no times → review); 40171 GOTY 0.68 |
| 620 | Portal 2 (2011) | 7231 | Portal 2 | 1.00 accept | 73092 "Portal 2 CO OP" 0.60 (omit); 50079 "Portal 2: COSMOGONY" 0.56 (reject) |
| 504230 | Celeste (2018) | 42818 | Celeste | 1.00 accept | 57798 "Celeste Classic" 0.65 (different 2015 game); 87629 "Celeste 2 (PICO-8)" 0.55 |
| 1145360 | Hades (2020) | 62941 | Hades | 1.00 accept | 118218 "Hades II" 0.76 (2025); 143659 "Hades 2" 0.68 |
| 374320 | Dark Souls III (2016) | 26803 | Dark Souls III | 1.00 accept | 46295 "Fire Fades Edition" 0.74; 77996 "Cinders" mod 0.65 reject |

Notes from the run:

- The correct entry wins all five, but **only because of the year/data/type penalties**. "Hades" alone returns 50 substring candidates in the snapshot ("s**hades** of darkness"), and "The Witcher 3: Wild Hunt" has a no-data duplicate that would score 0.99 without the "no times" penalty (0.84 with it). Both are evidence that a bare title match is not enough.
- `Dark Souls III` only matches because of the roman/arabic variant; a literal `dark souls 3` query finds no row in this snapshot.
- HLTB id **10270 → `profile_steam` 292030** is independently confirmed by the Ruby client's recorded fixture, so the App ID path for the first row is not hypothetical.
- Live verification still required at implementation time: one search + one detail request per title, checking that `profile_steam` equals the App ID and that `comp_main/3600` is plausible. That is ~10 requests if the first detail candidate matches (more if it does not) — well inside the pacing above.

## 6. Caching and fallbacks

Recommended cache (SQLite, alongside the rest of game-cat's local data):

| Item | TTL | Behaviour |
| --- | --- | --- |
| `appid → hltb_id` once `profile_steam` matched | permanent | avoids re-searching forever; user override can replace it |
| Times (`main`, `main+extra`, `completionist`, `all styles`) | 30 days, refresh in background | keep and show stale values when refresh fails |
| Negative ("not on HLTB") | 24 hours, then recheck | show `—` immediately; do not retry on every launch |
| Search endpoint path | 1 hour | from JS discovery; fall back to known paths |
| Auth token | 60 seconds | refetch `/init`; 1 s warm-up |
| "Unavailable" (network/429/endpoint broken) | not cached | old times stay; retry next launch |

game-glance's production values are a good sanity check: found times refreshed every **30 days** and kept "however old"; "no match" rechecked every **day**; "unavailable" never cached; one in-flight lookup per game; a **20 s** timeout so a dead request cannot block the UI ([cache.ts](https://github.com/michpalm/game-glance/blob/eb9f14dbec017821f62312441241955da3bd0348/src/data/cache.ts), [hltb/index.ts](https://github.com/michpalm/game-glance/blob/eb9f14dbec017821f62312441241955da3bd0348/src/data/hltb/index.ts)). The Safari userscript uses a simpler 7-day cache.

Fallback order at runtime:

1. cached value (even stale) → 2. App ID detail lookup → 3. title+year search → 4. user override → 5. `—`, mark for later. Never make the library view wait on HLTB; the feature must degrade to "no HLTB data" without an error state.

Do **not** ship the 166k dataset as a fallback: its upstream licence is "TBD", it is a point-in-time scrape, and redistributing it is exactly the bulk use this note advises against. It is useful only for offline experiments and tests.

## 7. Recommendation for game-cat v2

**GO, conditional**, with these non-negotiables:

1. A single `HltbSource` adapter behind an interface; all endpoint discovery, token handling, parsing and pacing live inside it. Swapping it out (or disabling it) must not touch the UI or the Smart Collection engine.
2. Server-side only, with a real browser `User-Agent`, `Origin`/`Referer`, serial 2 s pacing, `Retry-After` handling, and a circuit breaker after repeated failures.
3. App ID first (via `profile_steam`); title+year only as a scored fallback; store confidence and allow manual override.
4. Cache aggressively (30-day times, permanent ID mappings, 24-hour negatives) and enrich in a resumable background job — never in the request path.
5. Attribute How Long To Beat and deep-link each game to its HLTB page. No bulk export, no bundled data, no public proxy.
6. Treat the integration as optional/best-effort: if HLTB changes its endpoint or blocks the client, v2 still works with the field empty.

Before shipping, the maintainer must:

- fetch `https://howlongtobeat.com/robots.txt` from a normal network and record what it allows (especially `/api/` and `/game/`);
- re-check whether a terms page now exists and read it;
- run the 5-title live sample and confirm `profile_steam` matches;
- confirm the current route via the JS bundle (do not trust `/api/search/site` being current);
- measure one 429 recovery to confirm the backoff.

If `robots.txt` disallows the API or game pages, stop: the feature is not viable as specified, and v2 should ship without HLTB times.

## 8. Open questions

- **robots.txt**: unread. This is the gating unknown.
- **Terms**: no page found; absence is not permission. If HLTB/IGN publishes terms later, re-evaluate.
- **Long-term endpoint stability**: the route has been renamed at least three times (`/api/find` → `/api/finder` → `/api/bleed` → `/api/search/site`), with `/api/find` observed in April 2026 and `/api/search/site` in September 2026. Any implementation needs discovery + fallbacks, and should be treated as perishable.
- **Rate-limit ceiling**: 2 s is a conservative community norm, not a published limit. Measure politely; do not probe for the maximum.
- **Commercial distribution**: if game-cat is ever sold or hosted for others, get permission or drop the integration; a personal local tool is a different risk profile.

## Sources

Primary (the service and the recorded artefacts):

- HLTB site: <https://howlongtobeat.com> — no developer/API documentation found (the site itself was not fetchable here); footer links `/feedback`, `/conduct`, Ziff Davis privacy policy.
- HLTB `robots.txt`: <https://howlongtobeat.com/robots.txt> — **not fetched** (sandbox egress blocked).
- Ziff Davis privacy policy: <https://www.ziffdavis.com/privacy-policy>.
- Recorded HLTB game page used as the detail fixture: <https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/spec/fixtures/game_page.html>.

Maintained clients and one deliberately stale client (the de-facto protocol documentation):

- Python, `howlongtobeatpy` 1.0.24, commit `4275a45` (2026-10-02): [`HTMLRequests.py`](https://github.com/ScrappyCocco/HowLongToBeat-PythonAPI/blob/4275a452b9ccd230b7c2a82b8d1a5d851285eb14/howlongtobeatpy/howlongtobeatpy/HTMLRequests.py), [`JSONResultParser.py`](https://github.com/ScrappyCocco/HowLongToBeat-PythonAPI/blob/4275a452b9ccd230b7c2a82b8d1a5d851285eb14/howlongtobeatpy/howlongtobeatpy/JSONResultParser.py), [`conftest.py`](https://github.com/ScrappyCocco/HowLongToBeat-PythonAPI/blob/4275a452b9ccd230b7c2a82b8d1a5d851285eb14/howlongtobeatpy/tests/conftest.py).
- Ruby gem, commit `5edb476` (2026-11-04): [`client.rb`](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/lib/howlongtobeat/client.rb), [`http.rb`](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/lib/howlongtobeat/http.rb), [`game_page_parser.rb`](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/lib/howlongtobeat/game_page_parser.rb), [`records.rb`](https://github.com/dpashutskii/howlongtobeat/blob/5edb476f7085a14a8f54e9acfa77e9b2dd7f57ee/lib/howlongtobeat/records.rb).
- game-glance / `hltb-for-deck`, commit `eb9f14d` (2026-11-10): [`HltbApi.ts`](https://github.com/michpalm/game-glance/blob/eb9f14dbec017821f62312441241955da3bd0348/src/vendor/hltb-for-deck/hooks/HltbApi.ts), [`cache.ts`](https://github.com/michpalm/game-glance/blob/eb9f14dbec017821f62312441241955da3bd0348/src/data/cache.ts), [`hltb/index.ts`](https://github.com/michpalm/game-glance/blob/eb9f14dbec017821f62312441241955da3bd0348/src/data/hltb/index.ts).
- steam-hltb-safari, commit `709d706` (2026-09-27): [`README.md`](https://github.com/Phishion/steam-hltb-safari/blob/709d706d605d2dc8ec9c234418fe24f4face5170/README.md), [`steam-hltb-safari.user.js`](https://github.com/Phishion/steam-hltb-safari/blob/709d706d605d2dc8ec9c234418fe24f4face5170/steam-hltb-safari.user.js).
- npm `howlongtobeat@1.8.0` (2023-07), retained only to show the stale endpoint: [`hltbsearch.ts`](https://github.com/ckatzorke/howlongtobeat/blob/d57da96a95f16ee89959cad8fa30907a0504040f/src/main/hltbsearch.ts), [package page](https://www.npmjs.com/package/howlongtobeat/v/1.8.0).

Secondary:

- Independent profile noting no official API: <https://github.com/api-evangelist/howlongtobeat>.
- Field-tested scraping notes dated 2026-04-18 documenting `/api/find`: <https://github.com/browser-use/desktop/blob/main/app/src/main/hl/stock/domain-skills/howlongtobeat/scraping.md>.
- 2026-03-27 HLTB snapshot used only for the sample run (licence TBD, do not redistribute): <https://github.com/johagan94/hltb-dataset-plugin>.
- Independent source/licence review noting `/terms` 404 on 2026-11-02: <https://github.com/AlexGalhardo/vukem-hexascore/blob/main/docs/data/SOURCES.md>.
