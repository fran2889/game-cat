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
  await expect(page.getByTestId("match-count")).toHaveText("130 games match · updates as you edit");
  await expect(page.locator(".game-grid .game-card").first()).toBeVisible();

  // The rail opens with the mockup's eyebrow label; a new draft has no
  // autosave state until the first explicit Save.
  await expect(page.locator(".editor-head")).toContainText("Smart Collection");
  await expect(page.locator(".editor-head").getByTestId("save-state")).toHaveCount(0);

  const previewBox = await page.locator(".preview-pane").boundingBox();
  const editorBox = await page.locator(".editor-pane").boundingBox();
  expect(previewBox).not.toBeNull();
  expect(editorBox).not.toBeNull();
  expect(editorBox?.x).toBeGreaterThan(previewBox?.x ?? 0);
  expect(editorBox?.width).toBeCloseTo(370, 0);

  const add = page.getByRole("button", { name: "Add rule" });
  await expect(add).toHaveAccessibleName("Add rule");
  await expect(add.locator("svg")).toHaveCount(1);
  const actionsBox = await page.locator(".editor-actions").boundingBox();
  const addBox = await add.boundingBox();
  expect(addBox?.width).toBeCloseTo(actionsBox?.width ?? 0, 0);

  // The prototype's compact control heights and tighter panel padding.
  await expect(page.getByRole("button", { name: "Save" })).toHaveCSS("height", "26px");
  await expect(add).toHaveCSS("height", "26px");
  await expect(page.locator(".prefix-callout")).toHaveCSS("padding", "10px");
  await expect(page.locator(".prefix-callout p").first()).toHaveCSS("font-size", "12px");
  // The prefix summary is Mantine's light info Alert with an icon, not a
  // neutral bordered Paper.
  await expect(page.locator(".prefix-callout")).toHaveClass(/mantine-Alert-root/);
  await expect(page.locator(".prefix-callout svg")).toHaveCount(1);
  await expect(page.locator(".quick-add")).toHaveCSS("padding", "10px");

  await add.click();
  const row = page.locator('[data-rule-index="0"]');
  await expect(row).toHaveCSS("padding", "10px");
  await expect(row).toHaveCSS("box-shadow", /rgb\(51, 154, 240\) 3px 0px 0px 0px inset/);
  await expect(page.getByRole("button", { name: "Remove rule 1" }).locator("svg")).toHaveCount(1);

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
  // The active prefix button and the row edge share the same `-filled` token.
  const or = page.getByRole("button", { name: "OR prefix for Rule 1" });
  await or.click();
  await page.mouse.move(0, 0);
  await expect(row).toHaveCSS("box-shadow", /rgb\(255, 146, 43\) 3px 0px 0px 0px inset/);
  await expect(or).toHaveCSS("background-color", "rgb(255, 146, 43)");

  const not = page.getByRole("button", { name: "NOT prefix for Rule 1" });
  await not.click();
  await page.mouse.move(0, 0);
  await expect(row).toHaveCSS("box-shadow", /rgb\(255, 107, 107\) 3px 0px 0px 0px inset/);
  await expect(not).toHaveCSS("background-color", "rgb(255, 107, 107)");
});

test("Discard on a clean new collection leaves without saving", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  const discard = page.getByRole("button", { name: "Discard" });
  await expect(discard).toBeVisible();

  await discard.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "All games" })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("Discard on a dirty new collection asks before discarding", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await page.getByLabel("Name").fill("Draft that will be discarded");
  await page.getByRole("button", { name: "Discard" }).click();

  const dialog = page.getByRole("alertdialog", { name: "Leave with unsaved changes" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/smart\/new$/);

  await dialog.getByRole("button", { name: "Leave" }).click();
  await expect(page).toHaveURL(/\/$/);
  const listed = await page.request.get(`${app.url}api/smart-collections?pageSize=100`);
  const body = (await listed.json()) as { data: { name: string }[] };
  expect(body.data.map((collection) => collection.name)).not.toContain(
    "Draft that will be discarded",
  );
});

test("Discard is disabled while the first Save is in flight", async ({ page }) => {
  let releaseCreate: (() => void) | null = null;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route(/\/api\/smart-collections$/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await createGate;
    await route.continue();
  });

  await page.goto(`${app.url}smart/new`);
  await page.getByLabel("Name").fill("Created while gated");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Discard" })).toBeDisabled();

  releaseCreate!();
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);
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

  await page.getByRole("link", { name: "New collection" }).click();
  await expect(page).toHaveURL(/\/smart\/new$/);
  await expect(page.getByTestId("match-count")).toHaveText("130 games match · updates as you edit");
  await expect(page.locator(".game-grid .game-card").first()).toBeVisible();
  await expect(page.locator(".game-table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Table view" })).toHaveCount(0);
});

test("the sidebar create link also keeps the editor preview in grid", async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.locator(".game-table")).toBeVisible();

  await page.getByRole("link", { name: "New Smart Collection" }).click();
  await expect(page).toHaveURL(/\/smart\/new$/);
  await expect(page.locator(".game-grid .game-card").first()).toBeVisible();
  await expect(page.locator(".game-table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Table view" })).toHaveCount(0);
});

test("the rail header pairs the Smart Collection eyebrow with the autosave state", async ({
  page,
}) => {
  await page.goto(`${app.url}smart/new`);
  const head = page.locator(".editor-head");
  await expect(head).toContainText("Smart Collection");
  await page.getByRole("textbox", { name: "Name" }).fill("Header chrome");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);

  await expect(head.getByTestId("save-state")).toHaveText("Saved");
  await expect(head.locator(".editor-save-dot")).toHaveCount(1);
  await expect(head.getByTestId("save-state")).toHaveCSS("font-size", "12px");
  // The label and the state share one compact header row.
  const headBox = await head.boundingBox();
  const stateBox = await head.getByTestId("save-state").boundingBox();
  expect(Math.abs((stateBox?.y ?? 0) - (headBox?.y ?? 0))).toBeLessThan(20);

  await page.getByRole("textbox", { name: "Name" }).fill("Header chrome edited");
  await expect(head.getByTestId("save-state")).toHaveText("Unsaved changes");
});

test("rule rows describe their field, operator, and value", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await page.getByRole("button", { name: "Add rule" }).click();
  const row = page.locator('[data-rule-index="0"]');
  const description = row.locator(".rule-description");

  // An empty draft row still names its Field and Operator.
  await expect(description).toHaveText("Tag has…");
  await row.locator(".rule-value input").fill("Co-op");
  await expect(description).toHaveText('Tagged "Co-op"');

  await row.locator(".rule-field select").selectOption("playtime");
  await row.locator(".rule-operator select").selectOption("lte");
  await row.locator(".rule-value input").fill("20");
  await expect(description).toHaveText("Playtime ≤ 20 h");

  await row.locator(".rule-field select").selectOption("installed");
  await expect(description).toHaveText("Installed");
});

test("Select shown selects the preview page and Clear shown clears it", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 games match · updates as you edit");

  const select = page.getByRole("button", { name: "Select shown" });
  await expect(select).toBeVisible();
  await select.click();
  await expect(page.locator(".selection-count")).toHaveText("60 selected");
  await expect(page.locator(".preview-pane .game-card.is-selected")).toHaveCount(60);

  await page.getByRole("button", { name: "Clear shown" }).click();
  await expect(page.locator(".selection-bar")).toHaveCount(0);
  await expect(page.locator(".preview-pane .game-card.is-selected")).toHaveCount(0);

  // The same selection feeds the existing Add to current rules handoff.
  await page.getByRole("textbox", { name: "Name" }).fill("Shown selection");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Select shown" }).click();
  await page.getByRole("button", { name: "Add to current rules" }).click();
  await expect(page.getByTestId("prefix-counts")).toHaveText("1 AND · 0 OR · 0 NOT");
  await expect(page.getByTestId("match-count")).toHaveText("60 games match · updates as you edit");
});

test("Delete is an icon control that keeps its name and confirmation", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await page.getByRole("textbox", { name: "Name" }).fill("Delete chrome");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);

  const remove = page.locator(".editor-delete");
  await expect(remove).toHaveAccessibleName("Delete");
  await expect(remove.locator("svg")).toHaveCount(1);
  await remove.click();

  const dialog = page.getByRole("alertdialog", { name: "Delete Smart Collection" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("mobile stacks the editor above the preview", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 games match · updates as you edit");

  const previewBox = await page.locator(".preview-pane").boundingBox();
  const editorBox = await page.locator(".editor-pane").boundingBox();
  expect(previewBox).not.toBeNull();
  expect(editorBox).not.toBeNull();
  expect(editorBox!.y).toBeLessThan(previewBox!.y);
  expect(editorBox!.width).toBeCloseTo(previewBox!.width, 0);
});
