import { expect, test } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

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

test("the empty editor shows the global prefix copy and all-Games state", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("prefix-counts")).toHaveText("0 AND · 0 OR · 0 NOT");
  await expect(
    page.getByText(
      "Prefixes group globally: every AND must match, at least one OR must match, no NOT may match. They are not evaluated row by row.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("NOT removes matching games. It does not require the field to have a value."),
  ).toBeVisible();
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");
  await expect(
    page.getByText("No rules. This matches all 130 games. Add a rule to narrow it."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await expect(page.getByText("Save creates the Smart Collection.")).toBeVisible();
  await expect(page.locator(".game-grid .game-card")).toHaveCount(60);
});

test("Rule edits update counts, debounce preview, and skip the API while invalid", async ({
  page,
}) => {
  let previewCalls = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/rules/preview")) {
      previewCalls += 1;
    }
  });

  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");
  const initialCalls = previewCalls;

  await page.getByRole("button", { name: "+ Add rule" }).click();
  await expect(page.getByTestId("prefix-counts")).toHaveText("1 AND · 0 OR · 0 NOT");
  await expect(page.locator('[data-rule-index="0"] .rule-errors')).toContainText(
    "must not be empty",
  );
  await page.waitForTimeout(700);
  expect(previewCalls).toBe(initialCalls);

  await page.locator('[data-rule-index="0"] .rule-value input').fill("Puzzle");
  await expect(page.getByTestId("match-count")).toHaveText("1 matches");
  expect(previewCalls).toBeGreaterThan(initialCalls);
  await expect(page.locator(".game-grid .game-card")).toHaveCount(1);

  await page.getByRole("button", { name: "NOT prefix for Rule 1" }).click();
  await expect(page.getByTestId("prefix-counts")).toHaveText("0 AND · 0 OR · 1 NOT");
  await expect(page.getByTestId("match-count")).toHaveText("129 matches");

  await page.getByRole("button", { name: "Remove rule 1" }).click();
  await expect(page.getByTestId("prefix-counts")).toHaveText("0 AND · 0 OR · 0 NOT");
  await expect(
    page.getByText("No rules. This matches all 130 games. Add a rule to narrow it."),
  ).toBeVisible();
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");
});

test("no matches and invalid hours use the documented copy without calling the API", async ({
  page,
}) => {
  let previewCalls = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/rules/preview")) {
      previewCalls += 1;
    }
  });

  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");

  await page.getByRole("button", { name: "Playtime", exact: true }).click();
  await page.locator('[data-rule-index="0"] .rule-operator select').selectOption("gt");
  const hours = page.locator('[data-rule-index="0"] .rule-value input');
  await hours.fill("99999");
  await expect(
    page.getByText(
      "No games match these rules. An OR rule widens the result; a NOT rule removes games.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("match-count")).toHaveText("0 matches");
  const callsAfterMatch = previewCalls;

  await hours.fill("");
  await expect(page.locator('[data-rule-index="0"] .rule-errors')).toContainText(
    "must be at least 0",
  );
  await page.waitForTimeout(700);
  expect(previewCalls).toBe(callsAfterMatch);
  await expect(
    page.getByText(
      "No games match these rules. An OR rule widens the result; a NOT rule removes games.",
    ),
  ).toBeVisible();
});

test("a broad Rule pages through every match", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");
  await expect(page.locator(".pagination-range")).toHaveText("1–60 of 130");

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Page 2 of 3")).toBeVisible();
  await expect(page.locator(".pagination-range")).toHaveText("61–120 of 130");
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");
  await expect(page.locator(".game-grid .game-card")).toHaveCount(60);

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Page 3 of 3")).toBeVisible();
  await expect(page.locator(".pagination-range")).toHaveText("121–130 of 130");
  await expect(page.locator(".game-grid .game-card")).toHaveCount(10);
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
});

test("New from selection prefills one ascending game Rule", async ({ page }) => {
  await page.goto(app.url);
  const checks = page.locator(".game-card .select-check input");
  await checks.nth(0).check();
  await checks.nth(1).check();
  await page.getByRole("button", { name: "+ New from selection" }).click();
  await expect(page).toHaveURL(/\/smart\/new$/);

  await expect(page.getByTestId("prefix-counts")).toHaveText("1 AND · 0 OR · 0 NOT");
  const chips = page.locator('[data-rule-index="0"] .picker-chips .chip');
  await expect(chips).toHaveCount(2);
  const first = Number((await chips.nth(0).textContent())?.replace(/\D/g, ""));
  const second = Number((await chips.nth(1).textContent())?.replace(/\D/g, ""));
  expect(Number.isSafeInteger(first)).toBe(true);
  expect(first).toBeLessThan(second);
  await expect(page.getByTestId("match-count")).toHaveText("2 matches");
  await expect(page.locator(".game-grid .game-card")).toHaveCount(2);
});

test("the boolean Installed control toggles true and false", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");

  await page.getByRole("button", { name: "+ Add rule" }).click();
  await page.locator('[data-rule-index="0"] .rule-field select').selectOption("installed");
  const toggle = page.locator('[data-rule-index="0"] .rule-value input[type="checkbox"]');
  await expect(toggle).toBeChecked();
  await expect(page.locator('[data-rule-index="0"] .rule-value .unit')).toHaveText("true");
  await expect(page.getByTestId("match-count")).not.toHaveText("130 matches");
  const installedCount = await page.getByTestId("match-count").textContent();

  await toggle.uncheck();
  await expect(page.locator('[data-rule-index="0"] .rule-value .unit')).toHaveText("false");
  await expect(page.getByTestId("match-count")).not.toHaveText(installedCount ?? "");
});

test("the platform quick add emits one has Rule per selected platform", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");

  await page.getByLabel("linux").check();
  await expect(page.getByTestId("prefix-counts")).toHaveText("1 AND · 0 OR · 0 NOT");
  await expect(page.locator('[data-rule-index="0"] select').nth(0)).toHaveValue("platform");
  await expect(page.locator('[data-rule-index="0"] .rule-value select')).toHaveValue("linux");

  await page.getByLabel("windows").check();
  await expect(page.getByTestId("prefix-counts")).toHaveText("2 AND · 0 OR · 0 NOT");

  await page.getByLabel("linux").uncheck();
  await expect(page.getByTestId("prefix-counts")).toHaveText("1 AND · 0 OR · 0 NOT");
});
