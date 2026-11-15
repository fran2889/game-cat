# Use IUserReviewsService for Steam review summaries

## Status

Accepted (2026-11-15). Resolves [#42](https://github.com/fran2889/game-cat/issues/42).

## Context

The review adapter used the unofficial
`store.steampowered.com/appreviews/<appid>?json=1` endpoint. From the research and verification
environments it returned `302 Moved Temporarily` to the storefront homepage with an empty body, so
every Game finished `review_status = 'blocked'` and no score, tier, or count was stored.

Valve now documents `IUserReviewsService/GetAppReviews` as the replacement for `/appreviews`. The
documented endpoint is live and keyless: a request from the verification host returned `200` with
`response.query_summary` for App 620 while the old endpoint still redirected to the homepage.

## Decision

Use `GET https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/` for review summaries.
Pass the query as `input_json` and request `format=json`:

```json
{
  "appid": 620,
  "languages": ["all"],
  "purchase_type": 1,
  "review_type": 0,
  "filter": 1,
  "num_per_page": 1,
  "filter_offtopic_activity": false,
  "display_language": "english"
}
```

- `purchase_type: 1` is All and `review_type: 0` is All, matching the old `purchase_type=all`.
- `filter: 1` is Recent; it avoids the Helpful filter's day-range widening. The score fields are
  returned on the first page when `review_type` is All.
- `num_per_page: 1` is the smallest first page that returns the score fields.
- `filter_offtopic_activity: false` preserves the "no review-bomb adjustment" rule.
- `display_language: "english"` pins the tier string to English.
- No API key is sent. The key is only for `GetOwnedGames`; the new endpoint's higher rate limit is
  for a key associated with the app, which a normal player key is not.
- The replacement endpoint returned `200` directly in live checks for App IDs 100, 870, 620, 570,
  730, 10, 4000, and 999999, including the no-trailing-slash form; no same-origin redirect was
  observed. Treat any `3xx` as `blocked` and do not follow it: a redirect is not review data, and
  the old endpoint's homepage redirect is why it was replaced. This records the deviation from
  #42 AC1: the replacement returns JSON directly, so the adapter fails closed instead of following
  a redirect.
- Parse `response.query_summary` and check the HTTP status. There is no `success` field. A missing
  `response` or `query_summary` is a settled `unavailable` result; malformed counts are an error.
- Reviews use the `steam_web_api` host key with a 1.5-second interval. They no longer share the
  storefront host budget or its pauses, so storefront and review passes may run in parallel.

If Valve changes this endpoint, the adapter remains replaceable. If it disappears, revisit with a
replacement source or formally remove review summaries from the v1 surface.

## Consequences

- The documented replacement works on the verification host and stores `ok` rows; the old
  `/appreviews` redirect no longer blocks the source.
- Review summaries keep the same stored fields, score computation, tier copy, and API shape. The raw
  payload retains only `query_summary`; an envelope without a summary is stored as
  `{ "response": {} }`, and individual review text and author identifiers are discarded.
- A homepage/HTML response or any redirect still fails closed and never becomes "no reviews".
- Storefront and review passes can now run concurrently because they use different hosts.
- No API, UI, schema, or scoring changes are needed.
