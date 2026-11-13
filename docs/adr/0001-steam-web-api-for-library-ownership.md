# Use the Steam Web API for the full library roster

## Status

Accepted (2026-11-13). Supersedes the original [map](https://github.com/fran2889/game-cat/issues/1)
note that local Steam files are the sole source of library data.

## Context

The map originally made local Steam files the source of truth for the Library. Local files only
reveal installed Games, Games with playtime, and Steam Collection members; they do not enumerate
every owned Game. The v1 MVP requires the full game list, so local evidence alone cannot supply
the roster.

## Decision

Use `IPlayerService/GetOwnedGames/v1` with a user-supplied Steam Web API key and the selected
account's SteamID64 to establish the ownership roster. Local Steam files remain the source of
truth for installed state, playtime, last played, and Steam Collections. game-cat stores the
union, marks each Game `owned`, `local_only`, or `unknown`, and degrades to local evidence when
the API is unavailable. The key is server-side configuration and never enters SQLite, API
responses, or logs.

## Consequences

- First run needs a Web API key associated with a SteamID64; a private game-details profile can
  return an empty roster, which is treated as inconclusive rather than an empty Library.
- game-cat now depends on a public Valve endpoint whose parameters and rate limits are not fully
  documented. Ownership is one request per sync, so the operational risk is small.
- The Library can contain Games that are not installed, not played, and not in any Steam
  Collection, which is the point of the MVP.
- The map's "local files, not the Web API" constraint is superseded for ownership only. v1 is
  still read-only with respect to Steam files.
