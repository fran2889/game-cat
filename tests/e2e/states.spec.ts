import { expect, test, type Locator, type Page } from "@playwright/test";
import { blockExternalRequests, startTestApp } from "./fixture.ts";

/** Gate one API response so a loading state stays inspectable. */
function gateResponse(page: Page, pattern: string): Promise<() => void> {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return page
    .route(pattern, async (route) => {
      await opened;
      await route.continue();
    })
    .then(() => release);
}

async function gridTracks(locator: Locator): Promise<number[]> {
  const columns = await locator.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns,
  );
  return columns.split(" ").map((track) => Number.parseFloat(track));
}

async function expectFlushPortraitPlaceholder(skeleton: Locator): Promise<void> {
  await expect(skeleton).toHaveCSS("padding", "0px");
  const card = await skeleton.boundingBox();
  const cover = await skeleton.locator(".skeleton-cover").boundingBox();
  expect(card).not.toBeNull();
  expect(cover).not.toBeNull();
  // The placeholder is flush with the 1px card border and keeps the 2/3 slot.
  expect(cover?.width).toBeCloseTo((card?.width ?? 0) - 2, 0);
  expect((cover?.height ?? 0) / (cover?.width ?? 1)).toBeCloseTo(1.5, 1);
}

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

test("the initial load shows an aria-busy skeleton", async ({ page }) => {
  const app = await startTestApp({ games: 10 });
  try {
    await page.route("**/api/games?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    await page.goto(app.url);
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test("the Library loading grid reserves the card slot until cards arrive", async ({ page }) => {
  const app = await startTestApp({ games: 10 });
  try {
    const release = await gateResponse(page, "**/api/games?*");
    await page.goto(app.url);

    const skeleton = page.locator(".skeleton-card").first();
    await expect(skeleton).toBeVisible();
    await expectFlushPortraitPlaceholder(skeleton);
    const skeletonGrid = page.locator(".skeleton-grid");
    const skeletonTracks = await skeletonGrid.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns,
    );
    const skeletonBox = await skeleton.boundingBox();

    release();
    const card = page.locator(".game-card").first();
    await expect(card).toBeVisible();
    const cardBox = await card.boundingBox();
    expect(cardBox?.height).toBeCloseTo(skeletonBox?.height ?? 0, 0);
    const cardTracks = await page
      .locator(".game-grid")
      .first()
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
    expect(cardTracks).toBe(skeletonTracks);
  } finally {
    await app.close();
  }
});

test("the narrow grid keeps two columns and no overflow at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await startTestApp({ games: 10 });
  try {
    const release = await gateResponse(page, "**/api/games?*");
    await page.goto(app.url);

    const skeleton = page.locator(".skeleton-grid");
    await expect(skeleton).toBeVisible();
    const skeletonTracks = await gridTracks(skeleton);

    release();
    await expect(page.locator(".game-card").first()).toBeVisible();
    const cardTracks = await gridTracks(page.locator(".game-grid").first());
    expect(cardTracks).toEqual(skeletonTracks);
    expect(cardTracks).toHaveLength(2);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await app.close();
  }
});

test("the Steam and Smart Collection loading grids share the flush placeholder", async ({
  page,
}) => {
  const app = await startTestApp({ games: 10 });
  try {
    const releaseSteam = await gateResponse(page, "**/api/steam-collections/favorite/games?*");
    await page.goto(`${app.url}steam/favorite`);
    const steamSkeleton = page
      .locator('[aria-label="Loading the Steam Collection"] .skeleton-card')
      .first();
    await expect(steamSkeleton).toBeVisible();
    await expectFlushPortraitPlaceholder(steamSkeleton);
    releaseSteam();
    await expect(page.locator(".game-card").first()).toBeVisible();

    const created = await page.request.post(`${app.url}api/smart-collections`, {
      data: { name: "Loading parity", rules: [] },
    });
    expect(created.status()).toBe(201);
    const body = (await created.json()) as { data: { id: string } };
    const releaseSmart = await gateResponse(page, `**/api/smart-collections/${body.data.id}`);
    await page.goto(`${app.url}smart/${body.data.id}`);
    const smartSkeleton = page
      .locator('[aria-label="Loading the Smart Collection"] .skeleton-card')
      .first();
    await expect(smartSkeleton).toBeVisible();
    await expectFlushPortraitPlaceholder(smartSkeleton);
    releaseSmart();
    await expect(page.getByTestId("match-count")).toHaveText("10 matches");
  } finally {
    await app.close();
  }
});

test("the editor preview shows the shared loading grid until matches arrive", async ({ page }) => {
  const app = await startTestApp({ games: 10 });
  try {
    const created = await page.request.post(`${app.url}api/smart-collections`, {
      data: { name: "Preview loading", rules: [] },
    });
    expect(created.status()).toBe(201);
    const body = (await created.json()) as { data: { id: string } };
    const release = await gateResponse(page, "**/api/rules/preview*");
    await page.goto(`${app.url}smart/${body.data.id}`);

    const skeleton = page.locator('[aria-label="Loading matches"] .skeleton-card').first();
    await expect(skeleton).toBeVisible();
    await expectFlushPortraitPlaceholder(skeleton);

    release();
    await expect(page.getByTestId("match-count")).toHaveText("10 matches");
  } finally {
    await app.close();
  }
});

test("an empty Library renders No games found with recovery actions", async ({ page }) => {
  const app = await startTestApp({ empty: true, steamCollection: false });
  try {
    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "No games found." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Change Steam folder" })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("no Account keeps local Games usable and explains the warning", async ({ page }) => {
  const app = await startTestApp({ games: 10, account: false });
  try {
    await page.goto(app.url);
    await expect(page.getByText("No Steam Account selected.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open account picker" })).toBeVisible();
    await expect(page.locator(".game-card").first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a missing Steam root renders the Steam-not-found state", async ({ page }) => {
  const app = await startTestApp({ steamMissing: true });
  try {
    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "Steam was not found." })).toBeVisible();
    await expect(page.getByText(/Configured Steam folder:/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("an unknown route renders Not found with a Link back to the Library", async ({ page }) => {
  const app = await startTestApp({ games: 5 });
  try {
    await page.goto(`${app.url}not-a-real-route`);
    await expect(page.getByRole("heading", { name: "Not found", level: 2 })).toBeVisible();
    await page.getByRole("link", { name: "Back to Library" }).click();
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await app.close();
  }
});

test("a disconnected server shows the retry banner", async ({ page }) => {
  const app = await startTestApp({ games: 10 });
  try {
    await page.goto(app.url);
    await expect(page.locator(".game-card").first()).toBeVisible();
    await app.close();
    await page
      .locator("#sidebar")
      .getByRole("link", { name: /Installed/ })
      .click();
    await expect(
      page.getByText("Cannot reach game-cat. Is the server still running?").first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry connection" })).toBeVisible();
  } finally {
    await app.close();
  }
});
