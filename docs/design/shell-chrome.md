# Shell chrome and icon set

Issue [#88](https://github.com/fran2889/game-cat/issues/88) aligns the sidebar and top bar with the
prototype's icon and chrome language. The v1 specification leaves component appearance to Mantine:
[§7.10](../specs/game-cat-v1.md#710-visual-reference) says surfaces, colour tokens, spacing, and
branding are not contractual. This note records the values chosen here so a future change is
deliberate rather than accidental. The end-to-end tests assert the icon presence, the computed
metrics, and the accessible names.

## Icons

Every icon in the sidebar and top bar comes from `@tabler/icons-react`, pinned at the prototype's
version. Icons are decorative: each svg carries `aria-hidden="true"`, and the control keeps a visible
text label or an explicit accessible name. The accessible names are the visible labels ("Installed",
"New collection"); the old glyphs are gone from both the rendered text and the DOM attributes.

Icon sizes follow the surfaces: brand 20px in a 34px mark, view rows 17px, Smart Collection rows
16px, Steam Collection rows 16px, section actions 12–14px, and top-bar controls 14–18px. The status
card uses the refresh icon; its copy remains "Fetch" for the reason below.

## Sidebar

| Property         | Value                                  |
| ---------------- | -------------------------------------- |
| Icon column      | `18px`                                 |
| Label column     | `minmax(0, 1fr)`                       |
| Count column     | `auto`                                 |
| Gap              | `9px`                                  |
| Padding          | `7px 8px`                              |
| Radius           | `6px`                                  |
| Section padding  | `4px 8px`                              |
| Section heading  | title case in source, uppercase render |
| Count typography | normal text, never mono                |

The section heading is title case in the source and uppercased by the component, matching the
prototype. The brand is a 34px amber cat mark, an `lg` (18px) wordmark, the version badge, and a 12px
gap; the badge uses normal text as well.

The active-row treatment from [#81](https://github.com/fran2889/game-cat/issues/81) is unchanged:
Mantine owns the surface and hover, and `styles.css` owns the inset accent edge and shadow.

## Top bar

The search, sort, Installed, layout, and New collection controls use the same icon package. Their
geometry — height, padding, control widths, and the layout control itself — remains
[#76](https://github.com/fran2889/game-cat/issues/76). Replacing the glyphs changes the controls'
intrinsic widths; any deliberate width change belongs to that ticket.

## Deliberate deviations

- **Status copy stays `Fetch`.** The action sends `scope: all, mode: fetch`, so it fills gaps rather
  than re-requesting current sources. "Refresh all" would imply a Full Refresh. The refresh icon is
  the prototype's; the copy is deliberately different.
- **Accessible names use the visible labels.** The old buttons announced "✓ Installed" and
  "+ New collection" because the glyph was part of the text. Now the glyph is an icon, so the names
  are "Installed" and "New collection"; no text glyph remains anywhere in the shell.
- **The brand gap is pinned in the shell test.** Group writes its gap through the CSSOM, which CSP
  does not govern; `tests/e2e/shell-chrome.spec.ts` asserts the computed 12px under the real security
  header.

The shell tests in [`tests/e2e/shell-chrome.spec.ts`](../../tests/e2e/shell-chrome.spec.ts) pin the
icon presence, the row and section metrics, the brand and count typography, and the accessible names.
