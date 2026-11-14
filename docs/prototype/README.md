# v1 UI prototype

Throwaway clickable prototype for [issue #6](https://github.com/fran2889/game-cat/issues/6). Fidelity
is "react to it", not production code. The sample library is 41 games; playtime, tags, reviews, and
collection membership are invented. Cover art is fetched from the Steam CDN at runtime and falls
back to a tinted initials cover when the CDN is unavailable.

## Run it

Open `v1-ui.html` in a browser. No build step and no server are required.

```sh
xdg-open docs/prototype/v1-ui.html
```

If your browser refuses to load local files, serve the folder:

```sh
python3 -m http.server 8000 --directory docs/prototype
# then open http://localhost:8000/v1-ui.html
```

The prototype bar at the bottom switches states and times the 60-second job. It is collapsible on
narrow screens.

## The 60-second job

1. Select two or three games in the library.
2. Choose **New from selection**, or open a draft and add a **Game list** rule.
3. Add a **Tag** rule, a **Playtime** rule, and a **Steam Collection** rule.
4. Open the game list value and add games, or use **Use selection**.
5. Watch the match count, then save.

## What the prototype covers

- Library: cover grid and table, name-only search, sort, installed filter, installed indicator,
  selection.
- Smart Collections: list with live counts, create, rename, delete, active state, save and discard.
- Filter editor: prefix-first AND/OR/NOT rows, field/operator/value controls constrained by the
  grammar, add/remove, inline validation, live result preview.
- Game lists: game picker with search, selection handoff, chips, and a "new from selection"
  shortcut.
- Steam Collections: read-only list and view; dynamic collections are visible but disabled in the Rule
  picker, because their membership is not mirrored in v1.
- Game detail: metadata, tags with votes, Steam Collections, metadata status, store page link, and a
  proposed Launch action.
- States: first run, loading, empty library, metadata refresh in progress, ownership error, search
  with no results, and rules with no matches.
- Missing values: Caves of Qud has an unknown install state and a known-zero review count; Noita has
  missing tags. Delete all saved Smart Collections to see the empty-list prompt.

The rule evaluator follows the v1 grammar: AND rules all must match, at least one OR rule must
match when an OR rule exists, NOT rules veto, missing values are false, and an empty rule set matches
every game.

## What felt slow or confusing

These are the friction points I hit while building and clicking through it.

1. **Prefixes are global, but rows look local.** The editor has to explain that AND/OR/NOT are not
   evaluated row by row. Prefix-first controls help, but a user can still read the rows as a boolean
   expression. The live count and the prefix counts are the main mitigations. Consider an explicit
   "all / any / none" summary above the results.
2. **The game list hides behind a value control.** The fastest path is selecting games before
   creating the collection, then using **New from selection**. Inside an existing collection, the
   user must open the rule's picker or use **Use selection**. Two clicks is probably one too
   many; a persistent "selection tray" in the editor would be faster.
3. **Naming interrupts the flow.** The draft is prefilled with "New Smart Collection" so the job can
   finish without typing, but a real user will want to name it. Manual Save also adds a step. Consider
   autosave after the first save, with an undo affordance.
4. **Live preview is fine at 41 games, unknown at 1,300.** The prototype evaluates locally. The real
   preview endpoint is server-side, so the editor needs a debounce (250–400 ms), a pending indicator,
   and a way to keep the last result visible while the new one loads. Pagination or virtualization is
   still required for the library itself.
5. **"Exactly 10 hours" has no numeric `is`.** The grammar only has comparisons. A convenience "is"
   in the playtime control would have to emit two Rules; that is honest but visually noisy. The
   prototype leaves it out.
6. **Empty rules matching everything is surprising.** The empty state says "This matches all 41
   games" in the editor, but the result count alone would not make that obvious. Keep the sentence.
7. **NOT is a veto, not a negative assertion.** `NOT tag has Horror` removes tagged games but keeps
   untagged games. That is the right semantic for this product, but it is not what everyone means by
   "not horror". The rule description should keep saying "removes" rather than "is not".
8. **Dynamic Steam Collections need an explanation, not just a disabled option.** The picker labels
   them "dynamic" and the Steam Collection view explains why they are not mirrored. Users who expect
   a dynamic collection to work as a Rule will still be surprised.
9. **First run asks for an API key before showing anything.** The local scan can produce a useful
   library without the key. A better order might be: scan local files first, show installed games,
   then offer the roster upgrade. The prototype currently presents the key as step 2 of 3.
10. **Launch is not specified.** The detail drawer shows a Launch button labeled as a proposal. It is
    useful for judging the detail surface, but v1 is read-only. Decide whether launching belongs in
    v1 or waits for the desktop wrapper.
11. **Grid or table?** The grid is better for browsing covers; the table is better for comparing
    playtime and review scores. The prototype keeps both. The default should probably stay grid, with
    the choice remembered per view.
12. **The library remains usable during refresh and ownership failure.** That felt right. The banner
    is prominent without blocking the library, and the stale/partial state is visible in the sidebar.

## Open questions for feedback

- Should Save be explicit, autosaved, or autosaved after the first save?
- Should the New Smart Collection flow start from the library selection by default?
- Is the global prefix explanation enough, or does the editor need a visual group structure?
- Should the detail drawer offer Launch in v1?
- Should first run make the Steam Web API key optional and defer the full roster?
- Does the table need column sorting in the header, or is the toolbar sort enough?
- What should the refresh banner show for per-source failures instead of one aggregate count?

## Deliberately not included

- Production state management, routing, or API wiring.
- Virtualization or pagination for a 1,300-game library.
- Persistence across reloads. The prototype is in-memory; reload resets the sample data.
- Mobile-first layout work. The layout responds down to 390 px so states can be reviewed, but v1 is a
  local desktop browser app.
