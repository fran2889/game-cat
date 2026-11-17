import { expect, test } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

let app: TestApp;

test.beforeAll(async () => {
  app = await startTestApp({ games: 130 });
});

test.afterAll(async () => {
  await app?.close();
});

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

test("the editor is a right rail with a full-width Add rule and prefix accents", async ({
  page,
}) => {
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");
  await expect(page.locator(".game-grid .game-card").first()).toBeVisible();

  const previewBox = await page.locator(".preview-pane").boundingBox();
  const editorBox = await page.locator(".editor-pane").boundingBox();
  expect(previewBox).not.toBeNull();
  expect(editorBox).not.toBeNull();
  expect(editorBox?.x).toBeGreaterThan(previewBox?.x ?? 0);
  expect(editorBox?.width).toBeCloseTo(370, 0);

  const add = page.getByRole("button", { name: "+ Add rule" });
  const actionsBox = await page.locator(".editor-actions").boundingBox();
  const addBox = await add.boundingBox();
  expect(addBox?.width).toBeCloseTo(actionsBox?.width ?? 0, 0);

  // The mockup's compact control heights and tighter panel padding.
  await expect(page.getByRole("button", { name: "Save" })).toHaveCSS("height", "26px");
  await expect(add).toHaveCSS("height", "26px");
  await expect(page.locator(".prefix-callout")).toHaveCSS("padding", "10px");
  await expect(page.locator(".prefix-callout p").first()).toHaveCSS("font-size", "12px");
  await expect(page.locator(".quick-add")).toHaveCSS("padding", "10px");

  await add.click();
  const row = page.locator('[data-rule-index="0"]');
  await expect(row).toHaveCSS("padding", "10px");
  await expect(row).toHaveCSS("border-left-width", "3px");

  // The callout, rule list, Add rule, and quick add are all in the same
  // vertical rhythm; none of them may sit flush against its neighbour.
  const calloutBox = await page.locator(".prefix-callout").boundingBox();
  const ruleBox = await row.boundingBox();
  expect(
    (ruleBox?.y ?? 0) - ((calloutBox?.y ?? 0) + (calloutBox?.height ?? 0)),
  ).toBeGreaterThanOrEqual(10);
  const actionsRowBox = await page.locator(".editor-actions").boundingBox();
  const quickAddBox = await page.locator(".quick-add").boundingBox();
  expect(
    (quickAddBox?.y ?? 0) - ((actionsRowBox?.y ?? 0) + (actionsRowBox?.height ?? 0)),
  ).toBeGreaterThanOrEqual(10);
  await expect(row).toHaveCSS("border-left-color", "rgb(34, 139, 230)");

  const or = page.getByRole("button", { name: "OR prefix for Rule 1" });
  await or.click();
  await expect(row).toHaveCSS("border-left-color", "rgb(253, 126, 20)");
  // The filled variant uses orange shade 8; the edge uses shade 6.
  await expect(or).toHaveCSS("background-color", "rgb(217, 72, 15)");
});

test("Discard is available on a new collection and leaves without saving", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  const discard = page.getByRole("button", { name: "Discard" });
  await expect(discard).toBeVisible();

  await page.getByLabel("Name").fill("Draft that will be discarded");
  await discard.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "All games" })).toBeVisible();
});

test("leaving a dirty new collection asks before discarding", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await page.getByLabel("Name").fill("Unsaved draft");
  await page.getByRole("link", { name: "All games" }).click();

  const dialog = page.getByRole("alertdialog", { name: "Leave with unsaved changes" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(/\/smart\/new$/);
});

test("the editor preview stays in grid when the Library is in table view", async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.locator(".game-table")).toBeVisible();

  await page.getByRole("link", { name: "+ New collection" }).click();
  await expect(page).toHaveURL(/\/smart\/new$/);
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");
  await expect(page.locator(".game-grid .game-card").first()).toBeVisible();
  await expect(page.locator(".game-table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Table view" })).toHaveCount(0);
});
