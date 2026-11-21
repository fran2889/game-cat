# Grid density and card chrome

Issue [#87](https://github.com/fran2889/game-cat/issues/87) matches the Library, Steam Collection,
and Smart Collection grids to the prototype's density. The v1 specification leaves component
appearance to Mantine: [§7.10](specs/game-cat-v1.md#710-visual-reference) says surfaces, colour
tokens, spacing, and branding are not contractual. This note records the values chosen here so a
future change is deliberate rather than accidental. The end-to-end tests assert the structure, not
these exact pixels.

## Grid

| Property          | Value                               |
| ----------------- | ----------------------------------- |
| Track             | `repeat(auto-fill, minmax(148px, 1fr))` |
| Gap               | `14px`                              |
| Columns at 1280px | 6 (a 992px content box)             |
| Track at ≤460px   | `repeat(auto-fill, minmax(130px, 1fr))` |

The loading grid uses the same tracks and the same card shell, so the first paint and the settled
grid line up. The skeleton reserves one full results page: 60 cards, matching the Library and Steam
Collection page size.

## Card

- The cover is a flush 2/3 portrait capsule with top-only clipping at the card radius.
- The body uses `8px 32px 9px 9px` padding and a `74px` minimum height.
- Title: 12.5px, weight 650, line-height 1.25.
- Meta: 11px. Tags: 10.5px in `dark-3`. Ownership: inline 10px, weight 600, `orange-4`.
- Hover: `translateY(-1px)` and the stronger border, over 120ms. Both are disabled by
  `prefers-reduced-motion`.
- Installed is a filled green badge without a dot. Unknown uses the default surface with dimmed
  text, matching the prototype's `is-unknown` pill.

The title weight and line-height and the tag colour are prototype parity beyond the sizes listed in
#87: the prototype's `.card-title` uses `font-weight: 650; line-height: 1.25`, and `.card-tags`
uses its faint text token (`dark-3`).

## Deliberate deviations

- **32px right inset.** The prototype uses 9px. The extra width keeps the floating select checkbox
  from covering the meta or tag text.
- **Installed text is black.** The filled green token reads at 10.5:1 with black and 2.0:1 with
  white, which fails WCAG AA. The colour is emitted from `theme.ts` as
  `--game-cat-installed-badge-text`, not written in the component.
- **Ownership uses `orange-4`.** It reads at 9.4:1 on the card surface and keeps the prototype's
  warning tone.
- **Body height is reserved.** The skeleton uses the loaded card's 74px body slot. The exact value
  may change with Mantine's type metrics; the parity test compares the skeletal card's box with the
  loaded card's box, so both move together.
