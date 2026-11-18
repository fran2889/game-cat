import { expect, test, type Page } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

interface CspViolation {
  directive: string;
  sample: string;
}

let app: TestApp;

test.beforeAll(async () => {
  app = await startTestApp({ games: 130 });
  app.seedDetail(620);
});

test.afterAll(async () => {
  await app?.close();
});

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

/** Record every CSP violation from the first document, before app scripts run. */
async function collectCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const violations: CspViolation[] = [];
    Object.defineProperty(window, "__cspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push({ directive: event.effectiveDirective, sample: event.sample });
    });
  });
}

async function styleAttributeViolations(page: Page): Promise<CspViolation[]> {
  return page.evaluate(() => {
    const violations = (window as unknown as { __cspViolations?: CspViolation[] }).__cspViolations;
    return (violations ?? []).filter((violation) => violation.directive === "style-src-attr");
  });
}

test("the built app applies Mantine spacing under the real CSP", async ({ page }) => {
  await collectCspViolations(page);
  const response = await page.goto(app.url);
  const csp = response?.headers()["content-security-policy"] ?? "";
  const directives = new Map(
    csp.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values.join(" ")];
    }),
  );

  // Element-level protection stays strict; only style attributes are allowed.
  expect(directives.get("style-src")).toBe("'self'");
  expect(directives.get("style-src-attr")).toBe("'unsafe-inline'");
  expect(directives.get("script-src")).toBe("'self'");

  const brand = page.locator("#sidebar .brand");
  await expect(brand).toBeVisible();
  // Group writes `--group-gap: 12px` as a style attribute and its stylesheet
  // reads it back. React applies it through CSSOM, which CSP does not govern.
  await expect(brand).toHaveCSS("gap", "12px");

  // Style attributes that arrive as markup, as they would with SSR or a
  // framework that uses setAttribute, are governed by style-src-attr. The
  // Group stylesheet reads the variable and falls back to 16px when the
  // attribute is refused.
  const attrGap = await brand.evaluate((element) => {
    element.setAttribute("style", "--group-gap: 23px");
    return getComputedStyle(element).gap;
  });
  expect(attrGap).toBe("23px");

  expect(await styleAttributeViolations(page)).toEqual([]);
});

test("Library, detail panel, and Smart editor log no style-attribute violations", async ({
  page,
}, testInfo) => {
  await collectCspViolations(page);

  await page.goto(app.url);
  await expect(page.locator(".game-grid .game-card").first()).toBeVisible();
  expect(await styleAttributeViolations(page), `${testInfo.title}: Library`).toEqual([]);

  await page.goto(`${app.url}games/620`);
  await expect(page.locator('[role="dialog"].detail-dialog')).toBeVisible();
  expect(await styleAttributeViolations(page), `${testInfo.title}: detail panel`).toEqual([]);

  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("prefix-counts")).toBeVisible();
  expect(await styleAttributeViolations(page), `${testInfo.title}: Smart editor`).toEqual([]);
});
