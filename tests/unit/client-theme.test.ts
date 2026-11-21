import { describe, expect, it } from "vitest";
import { renderThemeCss, theme, themeTokens } from "../../src/client/theme.ts";

describe("client theme", () => {
  it("defines the v1 palette once", () => {
    expect(theme.primaryColor).toBe("amber");
    expect(theme.primaryShade).toBe(5);
    expect(theme.colors?.amber?.[5]).toBe("#f2b544");
    expect(theme.colors?.amber?.[6]).toBe("#ffc85c");
    expect(theme.colors?.dark).toEqual([
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
    ]);
    expect(themeTokens.primary.name).toBe("amber");
  });

  it("renders the documented variables", () => {
    const css = renderThemeCss();
    expect(css).toContain("--mantine-color-amber-5: #f2b544");
    expect(css).toContain("--mantine-color-amber-6: #ffc85c");
    expect(css).toContain("--mantine-color-amber-filled: var(--mantine-color-amber-5)");
    expect(css).toContain("--mantine-color-amber-filled-hover: var(--mantine-color-amber-6)");
    // Non-primary colours stay on shade 5, so autoContrast keeps green filled
    // controls on a dark label (green-8 + white was 3.44:1).
    expect(css).toContain("--mantine-color-green-filled: var(--mantine-color-green-5)");
    expect(css).toContain("--mantine-color-dark-7: #0f1115");
    expect(css).toContain("--mantine-color-dark-6: #15181e");
    expect(css).toContain("--mantine-color-dark-5: #1b1f27");
    expect(css).toContain("--mantine-color-dark-4: #2a303c");
    // The dark-2/dark-4 aliases already match Mantine's defaults; the ramp
    // values behind them are what changes.
    expect(css).toContain("--mantine-color-dark-2: #9aa3b5");
    expect(css).toContain("--mantine-color-dark-3: #8b94a6");
  });
});
