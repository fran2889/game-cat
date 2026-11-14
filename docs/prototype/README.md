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
  Launch action.
- States: first run, loading, empty library, metadata refresh in progress, ownership error, search
  with no results, and rules with no matches.
- Missing values: Caves of Qud has an unknown install state and a known-zero review count; Noita has
  missing tags. Delete all saved Smart Collections to see the empty-list prompt.

The rule evaluator follows the v1 grammar: AND rules all must match, at least one OR rule must
match when an OR rule exists, NOT rules veto, missing values are false, and an empty rule set matches
every game.

## Decisions after review

The prototype above is the **pre-review snapshot**. These decisions were made after clicking through
it on 2026-11-14; not all of them are implemented in the snapshot.

| Topic                    | Decision                                                          | #8 follow-through                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save model               | Autosave after the first explicit save.                           | Add debounce, save-failure retry, and a saved/unsaved indicator; remove the manual Save requirement after the first save.                               |
| New collection entry     | Keep the current flow: explicit New, optional New from selection. | No change.                                                                                                                                              |
| Prefix explanation       | The current global callout and counts are clear enough.           | Do not add nested groups; keep the "grouped globally" copy.                                                                                             |
| Launch                   | Include Launch in v1.                                             | Enable for installed Games; define `steam://` failure and not-installed behavior. v1 still never writes Steam files.                                    |
| First run                | The Steam Web API key is required.                                | No deferred or optional-key onboarding path in v1. The library is incomplete without the key.                                                           |
| Table sorting            | Sort from the table headers.                                      | Implemented for Game, Playtime, Last played, and Released. Keep it in #8; Review and Installed need API sort fields before they can be header-sortable. |
| Refresh and error detail | Link to a separate view that lists sync errors.                   | Define the route/view, per-source rows, and the banner link; keep the aggregate banner as the summary.                                                  |

## Left for the #8 spec

- Grid vs table default, and whether the choice persists per view.
- Autosave debounce interval, conflict handling, and undo.
- Exact sync-errors view content and whether it is a route or a dialog.
- Launch failure handling when Steam is not running or the Game is not installed.
- Virtualization or pagination for a 1,300-game library and the live preview latency budget.
- Empty-rules and NOT-veto copy in the final UI.

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
   autosave after the first save, with an undo affordance. **Decision: autosave after the first
   save.**
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
   then offer the roster upgrade. **Decision: the key stays required; keep the current required
   step.**
10. **Launch was not specified.** The detail drawer showed a Launch button labeled as a proposal. It
    was useful for judging the detail surface. **Decision: include Launch in v1.** v1 remains
    read-only with respect to Steam files.
11. **Grid or table?** The grid is better for browsing covers; the table is better for comparing
    playtime and review scores. The prototype keeps both. The default should probably stay grid, with
    the choice remembered per view.
12. **The library remains usable during refresh and ownership failure.** That felt right. The banner
    is prominent without blocking the library, and the stale/partial state is visible in the sidebar.

## Deliberately not included

- Production state management, routing, or API wiring.
- Virtualization or pagination for a 1,300-game library.
- Persistence across reloads. The prototype is in-memory; reload resets the sample data.
- Mobile-first layout work. The layout responds down to 390 px so states can be reviewed, but v1 is a
  local desktop browser app.
