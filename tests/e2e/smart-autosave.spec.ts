import { expect, test, type Page } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

async function createCollection(page: Page, url: string, name: string): Promise<void> {
  await page.goto(`${url}smart/new`);
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
}

test("autosave shows Saved, Unsaved changes, Saving…, and Saved next to the name", async ({
  page,
}) => {
  const app = await startTestApp({ games: 20 });
  try {
    await createCollection(page, app.url, "Autosave target");

    let releasePatch: (() => void) | null = null;
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    await page.route(/\/api\/smart-collections\/[^/]+$/, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      await patchGate;
      await route.continue();
    });

    const name = page.getByRole("textbox", { name: "Name" });
    await name.fill("Autosaved rename");
    await expect(page.getByTestId("save-state")).toHaveText("Unsaved changes");
    await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();
    await expect(page.getByTestId("save-state")).toHaveText("Saving…");

    releasePatch!();
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
    await expect(
      page.getByTestId("smart-collection-list").getByRole("link", { name: /Autosaved rename/ }),
    ).toBeVisible();

    // Discard reverts the newer unsaved edit to the autosaved name, not the
    // original create name.
    await name.fill("Discarded draft");
    await expect(page.getByTestId("save-state")).toHaveText("Unsaved changes");
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(name).toHaveValue("Autosaved rename");
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
  } finally {
    await app.close();
  }
});

test("Ctrl/Cmd+S forces an immediate save when the editor is valid", async ({ page }) => {
  const app = await startTestApp({ games: 20 });
  try {
    await createCollection(page, app.url, "Keyboard target");
    await page.getByRole("textbox", { name: "Name" }).fill("Keyboard saved");

    // The 500 ms budget is shorter than the 600 ms autosave debounce.
    const request = page.waitForRequest(
      (candidate) =>
        candidate.method() === "PATCH" &&
        /\/api\/smart-collections\/[^/]+$/.test(new URL(candidate.url()).pathname),
      { timeout: 500 },
    );
    await page.keyboard.press("Control+s");
    await request;
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
    await expect(
      page.getByTestId("smart-collection-list").getByRole("link", { name: /Keyboard saved/ }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a failed save keeps edits, retries, and blocks navigation until confirmed", async ({
  page,
}) => {
  const app = await startTestApp({ games: 20 });
  try {
    await createCollection(page, app.url, "Recovery target");

    let failAll = false;
    let failedOnce = false;
    await page.route(/\/api\/smart-collections\/[^/]+$/, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      if (failAll || !failedOnce) {
        failedOnce = true;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "INTERNAL_ERROR", message: "Server unavailable" },
          }),
        });
        return;
      }
      await route.continue();
    });

    const name = page.getByRole("textbox", { name: "Name" });
    await name.fill("Retry succeeds");
    await expect(page.getByTestId("save-state")).toHaveText("Save failed", { timeout: 5_000 });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("save-state")).toHaveText("Saved");

    failAll = true;
    await name.fill("Navigation blocked");
    await expect(page.getByTestId("save-state")).toHaveText("Save failed", { timeout: 5_000 });

    await page.getByRole("link", { name: "All games" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Leave with a failed save" });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);

    await dialog.getByRole("button", { name: "Stay" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);

    await page.getByRole("link", { name: "All games" }).click();
    await page.getByRole("button", { name: "Leave" }).click();
    await expect(page).toHaveURL(app.url);
  } finally {
    await app.close();
  }
});

test("Add to current rules extends the one game Rule and autosaves it", async ({ page }) => {
  const app = await startTestApp({ games: 20 });
  try {
    await createCollection(page, app.url, "Selection target");
    await expect(page.getByTestId("match-count")).toHaveText("20 matches");

    const checks = page.locator(".preview-pane .game-card input[type=checkbox]");
    await checks.nth(0).check();
    await checks.nth(1).check();
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByRole("button", { name: "Add to current rules" }).click();

    await expect(page.getByTestId("prefix-counts")).toHaveText("1 AND · 0 OR · 0 NOT");
    await expect(page.locator('[data-rule-index="0"] .rule-field select')).toHaveValue("game");
    await expect(page.locator('[data-rule-index="0"] .picker-chips .chip')).toHaveCount(2);
    await expect(page.getByTestId("match-count")).toHaveText("2 matches");
    await expect(page.getByTestId("save-state")).toHaveText("Saved");

    // Adding the same selection again extends the existing Rule instead of
    // creating a second game Rule.
    await page.getByRole("button", { name: "Add to current rules" }).click();
    await expect(page.getByTestId("prefix-counts")).toHaveText("1 AND · 0 OR · 0 NOT");

    await expect
      .poll(async () => {
        const response = await page.request.get(`${app.url}api/smart-collections`);
        const body = (await response.json()) as {
          data: Array<{ id: string; matchCount: number }>;
        };
        return body.data[0]?.matchCount ?? null;
      })
      .toBe(2);
  } finally {
    await app.close();
  }
});

test("an autosaved NAME_CONFLICT keeps the draft and links to the conflicting Collection", async ({
  page,
}) => {
  const app = await startTestApp({ games: 20 });
  try {
    await createCollection(page, app.url, "Conflict one");
    const firstId = page.url().split("/").at(-1)!;
    await createCollection(page, app.url, "Conflict two");

    await page.getByRole("textbox", { name: "Name" }).fill("Conflict one");
    await expect(page.getByTestId("save-state")).toHaveText("Save failed", { timeout: 5_000 });
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Conflict one");
    await expect(page.getByText("A Smart Collection with this name already exists.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open the conflicting collection" }),
    ).toHaveAttribute("href", `/smart/${firstId}`);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("an autosaved 422 maps dotted Rule field errors onto the editor", async ({ page }) => {
  const app = await startTestApp({ games: 20 });
  try {
    await createCollection(page, app.url, "Validation target");
    await page.getByRole("button", { name: "+ Add rule" }).click();
    await page.locator('[data-rule-index="0"] .rule-value input').fill("Puzzle");
    await expect(page.getByTestId("save-state")).toHaveText("Saved");

    await page.route(/\/api\/smart-collections\/[^/]+$/, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request body is invalid",
            details: {
              fieldErrors: {
                name: "must be 1-80 characters",
                "rules.0.value": "must be a string",
              },
            },
          },
        }),
      });
    });

    await page.getByRole("textbox", { name: "Name" }).fill("Server rejects this");
    await expect(page.getByText("must be 1-80 characters")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-rule-index="0"] .rule-errors')).toContainText(
      "must be a string",
    );
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Server rejects this");
    await expect(page.getByTestId("save-state")).toHaveText("Save failed");
  } finally {
    await app.close();
  }
});

test("New from selection limits the draft and clears the Library selection after create", async ({
  page,
}) => {
  const app = await startTestApp({ games: 20 });
  try {
    await page.goto(app.url);
    const newButton = page.getByRole("button", { name: "+ New from selection" });
    await expect(newButton).toBeDisabled();
    await expect(
      page.getByText("Select at least one game to create a Smart Collection."),
    ).toBeVisible();

    const checks = page.locator(".game-card input[type=checkbox]");
    await checks.nth(0).check();
    await checks.nth(1).check();
    await expect(newButton).toBeEnabled();
    await newButton.click();

    await expect(page).toHaveURL(/\/smart\/new$/);
    await expect(page.getByTestId("prefix-counts")).toHaveText("1 AND · 0 OR · 0 NOT");
    await expect(page.getByTestId("match-count")).toHaveText("2 matches");

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);

    await page.getByRole("link", { name: "All games" }).click();
    await expect(page).toHaveURL(app.url);
    await expect(page.locator(".selection-count")).toHaveText("0 selected");
  } finally {
    await app.close();
  }
});
