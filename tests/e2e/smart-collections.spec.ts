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

test("the empty sidebar offers the Create CTA and an 80-code-point name field", async ({
  page,
}) => {
  const empty = await startTestApp({ games: 5 });
  try {
    await page.goto(empty.url);
    await expect(page.getByText(/No Smart Collections yet\./)).toBeVisible();
    await page.getByRole("link", { name: "Create one" }).click();
    await expect(page).toHaveURL(/\/smart\/new$/);
    const name = page.getByRole("textbox", { name: "Name" });
    // No UTF-16 `maxLength` cap: 80 astral characters are 160 code units.
    await expect(name).not.toHaveAttribute("maxlength");
    await expect(name).toHaveValue("New Smart Collection");

    await name.fill("😀".repeat(80));
    await expect(page.getByText("The name must be 80 characters or fewer.")).toHaveCount(0);
    await name.fill("😀".repeat(81));
    await expect(page.getByText("The name must be 80 characters or fewer.")).toBeVisible();
  } finally {
    await empty.close();
  }
});

test("create, reopen, rename, and delete a Smart Collection with a live sidebar count", async ({
  page,
}) => {
  const perCollectionRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/smart-collections\/[^/]+$/.test(path)) {
      perCollectionRequests.push(path);
    }
  });

  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 games match · updates as you edit");
  await page.getByRole("textbox", { name: "Name" }).fill("Co-op picks");
  await page.getByRole("button", { name: "+ Add rule" }).click();
  await page.locator('[data-rule-index="0"] .rule-value input').fill("Co-op");
  await expect(page.getByTestId("match-count")).toHaveText("1 game matches · updates as you edit");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);
  const savedUrl = page.url();
  const sidebarList = page.getByTestId("smart-collection-list");
  await expect(sidebarList.getByRole("link", { name: /Co-op picks/ })).toContainText("1");

  // Reopen from the sidebar: the saved name and Rules are in the editor.
  await page.getByRole("link", { name: "All games" }).click();
  await expect(page).toHaveURL(app.url);
  perCollectionRequests.length = 0;
  await expect(sidebarList.getByRole("link", { name: /Co-op picks/ })).toContainText("1");
  expect(perCollectionRequests).toEqual([]);
  await sidebarList.getByRole("link", { name: /Co-op picks/ }).click();
  await expect(page).toHaveURL(savedUrl);
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Co-op picks");
  await expect(page.getByTestId("prefix-counts")).toHaveText("1 AND · 0 OR · 0 NOT");
  await expect(page.getByTestId("match-count")).toHaveText("1 game matches · updates as you edit");

  // Rename explicitly and see the sidebar follow the new name.
  await page.getByRole("textbox", { name: "Name" }).fill("Co-op favourites");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByTestId("smart-collection-list").getByRole("link", { name: /Co-op favourites/ }),
  ).toBeVisible();

  // Delete asks for confirmation, removes the sidebar row, and returns to `/`.
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete Smart Collection" })).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(app.url);
  await expect(
    page.getByTestId("smart-collection-list").getByRole("link", { name: /Co-op favourites/ }),
  ).toHaveCount(0);
});

test("a duplicate name keeps the draft and links to the conflicting Collection", async ({
  page,
}) => {
  await page.goto(`${app.url}smart/new`);
  await page.getByRole("textbox", { name: "Name" }).fill("Sidebar conflict");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);
  const firstId = page.url().split("/").at(-1)!;

  await page.goto(`${app.url}smart/new`);
  await page.getByRole("textbox", { name: "Name" }).fill("  sidebar CONFLICT ");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(/\/smart\/new$/);
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("  sidebar CONFLICT ");
  await expect(page.getByText("A Smart Collection with this name already exists.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the conflicting collection" })).toHaveAttribute(
    "href",
    `/smart/${firstId}`,
  );

  // Clean up so later tests start from a known sidebar.
  await page.goto(`${app.url}smart/${firstId}`);
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(app.url);
});

test("a 422 maps dotted Rule field errors and the name error onto the editor", async ({ page }) => {
  await page.route("**/api/smart-collections", async (route) => {
    if (route.request().method() !== "POST") {
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
          requestId: "e2e-request",
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

  await page.goto(`${app.url}smart/new`);
  await page.getByRole("textbox", { name: "Name" }).fill("Server rejects this");
  await page.getByRole("button", { name: "+ Add rule" }).click();
  await page.locator('[data-rule-index="0"] .rule-value input').fill("Puzzle");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(/\/smart\/new$/);
  await expect(page.getByText("must be 1-80 characters")).toBeVisible();
  await expect(page.locator('[data-rule-index="0"] .rule-errors')).toContainText(
    "must be a string",
  );
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Server rejects this");

  await page.unroute("**/api/smart-collections");
});
