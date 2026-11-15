import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Shared accessibility assertions for the Playwright suite (§7.9, AC-U18-U19).
 *
 * The project bar is zero serious or critical axe violations. The full result
 * (moderate and minor included) is kept in the failure message so a regression
 * is diagnosable without re-running with a debugger.
 */
export const AXE_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
  "best-practice",
] as const;

export async function collectA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
  return results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
}

export async function expectNoSeriousA11yViolations(page: Page, screen: string): Promise<void> {
  const violations = await collectA11yViolations(page);
  const summary = violations
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => `  - ${node.target.join(" ")}: ${node.failureSummary ?? ""}`)
        .join("\n");
      return `${violation.id} (${violation.impact}): ${violation.help}\n${nodes}`;
    })
    .join("\n\n");
  if (violations.length > 0) {
    throw new Error(`${screen} has serious or critical axe violations:\n${summary}`);
  }
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    pageWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(metrics.pageWidth, "the page must not scroll horizontally").toBeLessThanOrEqual(
    metrics.viewport,
  );
  expect(metrics.bodyWidth, "the body must not scroll horizontally").toBeLessThanOrEqual(
    metrics.viewport,
  );
}
