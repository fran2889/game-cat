import {
  convertCssVariables,
  createTheme,
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
  type MantineColorsTuple,
} from "@mantine/core";

const FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_FAMILY_MONOSPACE =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

/**
 * The v1 palette. Every colour this theme overrides is defined here; the rest
 * come from Mantine's defaults. The generated stylesheet in
 * `theme.generated.css` is derived from the same object.
 *
 * Primary shade 5 is the filled accent (#f2b544) and shade 6 is its brighter
 * hover (#ffc85c). Mantine reads the next shade for `-filled-hover`; keeping
 * shade 5 for every named colour preserves autoContrast on non-primary filled
 * controls, such as the green AND prefix.
 */
const amber: MantineColorsTuple = [
  "#fff8e6",
  "#ffefc2",
  "#ffe39a",
  "#ffd66b",
  "#f9c94a",
  "#f2b544",
  "#ffc85c",
  "#f7bd3d",
  "#f4b23f",
  "#e6a232",
];

/**
 * The original v1 dark ramp, mapped onto Mantine's ten `dark` shades. This is
 * not a one-to-one copy: Mantine uses dark-7 for the body, dark-6 for the
 * default surface, dark-5 for hover, dark-4 for the default border, and
 * dark-0..3 for text and muted text. dark-8 and dark-9 carry the two deepest
 * surfaces that the prototype used by name.
 *
 * | shade | token      | value   | Mantine role                       |
 * | ----- | ---------- | ------- | ---------------------------------- |
 * | 0     | text       | #e8eaf0 | body text                          |
 * | 1     | text-bright | #c9cfdb | strong secondary text             |
 * | 2     | text-muted | #9aa3b5 | dimmed text                        |
 * | 3     | text-faint | #8b94a6 | placeholders                       |
 * | 4     | border     | #2a303c | default border                     |
 * | 5     | surface-2  | #1b1f27 | default hover                      |
 * | 6     | surface-1  | #15181e | default surface                    |
 * | 7     | page       | #0f1115 | body background                    |
 * | 8     | surface-3  | #222733 | editor/stat surfaces               |
 * | 9     | surface-4  | #2a303d | selected rows and deep chrome      |
 *
 * The prototype's stronger border (#3b4352) has no Mantine dark-shade alias;
 * it is emitted separately as `--game-cat-border-strong`.
 */
const dark: MantineColorsTuple = [
  "#e8eaf0",
  "#c9cfdb",
  "#9aa3b5",
  "#8b94a6",
  "#2a303c",
  "#1b1f27",
  "#15181e",
  "#0f1115",
  "#222733",
  "#2a303d",
];

const PRIMARY_COLOR = "amber";
const PRIMARY_SHADE = 5;
/** The prototype's stronger border, exposed as a custom property. */
const BORDER_STRONG = "#3b4352";

export const theme = createTheme({
  primaryColor: PRIMARY_COLOR,
  primaryShade: PRIMARY_SHADE,
  colors: { amber, dark },
  defaultRadius: "md",
  fontFamily: FONT_FAMILY,
  fontFamilyMonospace: FONT_FAMILY_MONOSPACE,
  headings: { fontFamily: FONT_FAMILY },
  // Amber is a light primary; dark labels keep AA contrast on filled controls.
  autoContrast: true,
});

function changedVariables(
  current: Record<string, string>,
  defaults: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(current).filter(([name, value]) => defaults[name] !== value),
  );
}

/**
 * The CSS Mantine would inject at runtime, derived from the same theme object
 * and reduced to the variables that differ from Mantine's defaults. The build
 * writes this to `theme.generated.css`; the provider then runs with
 * `withCssVariables={false}` and `withGlobalClasses={false}`. The stylesheet is
 * generated, not committed; restart `npm run dev` after editing this module.
 */
export function renderThemeCss(): string {
  const merged = mergeMantineTheme(DEFAULT_THEME, theme);
  const current = defaultCssVariablesResolver(merged);
  const defaults = defaultCssVariablesResolver(DEFAULT_THEME);
  // Mantine defaults anchors to blue; v1 links use the primary accent.
  current.light["--mantine-color-anchor"] = "var(--mantine-primary-color-filled)";
  current.dark["--mantine-color-anchor"] = "var(--mantine-primary-color-filled)";
  const css = convertCssVariables(
    {
      variables: {
        ...changedVariables(current.variables, defaults.variables),
        "--game-cat-border-strong": BORDER_STRONG,
      },
      light: changedVariables(current.light, defaults.light),
      dark: changedVariables(current.dark, defaults.dark),
    },
    ":root",
  );
  return `/* Generated from src/client/theme.ts by scripts/generate-theme-css.mjs. */\n${css}\n`;
}
