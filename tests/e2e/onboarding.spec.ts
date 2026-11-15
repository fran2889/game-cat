import { expect, test, type Request } from "@playwright/test";
import { blockExternalRequests, startTestApp } from "./fixture.ts";

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

test("AC-U1 with no key every route redirects to onboarding", async ({ page }) => {
  const app = await startTestApp({ games: 5, noKey: true });
  try {
    await page.goto(app.url);
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Connect your Steam library" })).toBeVisible();
    await expect(
      page.getByText("game-cat reads local Steam files and never writes to Steam."),
    ).toBeVisible();

    await page.goto(`${app.url}installed`);
    await expect(page).toHaveURL(/\/onboarding$/);
    await page.goto(`${app.url}settings`);
    await expect(page).toHaveURL(/\/onboarding$/);
  } finally {
    await app.close();
  }
});

test("with a key the Library loads instead of onboarding", async ({ page }) => {
  const app = await startTestApp({ games: 5 });
  try {
    await page.goto(app.url);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".game-card").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Connect your Steam library" })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("Scan saves the key with PATCH and then starts all + Fetch", async ({ page }) => {
  const app = await startTestApp({ games: 5, noKey: true });
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const record = (request: Request): void => {
    const url = new URL(request.url());
    if (request.method() === "PATCH" && url.pathname === "/api/config") {
      requests.push({
        method: request.method(),
        url: url.pathname,
        body: request.postDataJSON(),
      });
    }
    if (request.method() === "POST" && url.pathname === "/api/refresh") {
      requests.push({
        method: request.method(),
        url: url.pathname,
        body: request.postDataJSON(),
      });
    }
  };
  page.on("request", record);

  try {
    await page.goto(app.url);
    await expect(page).toHaveURL(/\/onboarding$/);
    await page.getByLabel("Steam Web API key").fill("new-onboarding-key");
    await page.getByRole("button", { name: "Scan library" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".game-card").first()).toBeVisible();
    await page.reload();
    await expect(page.locator(".game-card").first()).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.url).toBe("/api/config");
    expect(requests[0]?.body).toMatchObject({ steamApiKey: "new-onboarding-key" });
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.url).toBe("/api/refresh");
    expect(requests[1]?.body).toEqual({ scope: "all", mode: "fetch" });

    await page.goto(`${app.url}settings`);
    await expect(page.locator(".settings-facts")).toContainText("Configured");
  } finally {
    page.off("request", record);
    await app.close();
  }
});

test("missing Steam and no Account render documented onboarding guidance", async ({ page }) => {
  const missing = await startTestApp({ games: 5, noKey: true, steamMissing: true });
  try {
    await page.goto(missing.url);
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByText(/Steam was not found at the configured path/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Change" })).toBeVisible();
  } finally {
    await missing.close();
  }

  const noAccount = await startTestApp({ games: 5, noKey: true, account: false });
  try {
    await page.goto(noAccount.url);
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByText(/No Steam Account was detected/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Recheck accounts" })).toBeVisible();
  } finally {
    await noAccount.close();
  }
});

test("an invalid key keeps the Library usable and offers Fix API key and Retry", async ({
  page,
}) => {
  const app = await startTestApp({ games: 5 });
  try {
    app.server.database.raw
      .prepare("UPDATE source_state SET status = 'invalid_key' WHERE name = 'steam_web_api'")
      .run();
    await page.goto(app.url);

    await expect(page.getByText("Steam rejected the Web API key.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Fix API key" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.locator(".game-card").first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("an empty roster with local evidence warns about a private profile and offers actions", async ({
  page,
}) => {
  const app = await startTestApp({ games: 5 });
  try {
    app.server.database.raw
      .prepare("UPDATE source_state SET status = 'empty' WHERE name = 'steam_web_api'")
      .run();
    await page.goto(app.url);

    await expect(page.getByText("Steam returned no owned Games.")).toBeVisible();
    await expect(page.getByText(/its Steam profile may be private/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Fix API key" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.locator(".game-card").first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("settings exposes the non-secret config, Account, and the restart explanation", async ({
  page,
}) => {
  const app = await startTestApp({ games: 5 });
  try {
    await page.goto(`${app.url}settings`);
    await expect(page.getByRole("heading", { name: "Configuration" })).toBeVisible();
    await expect(page.getByText("Player One · 76561198000000000").first()).toBeVisible();
    await expect(page.locator(".settings-facts")).toContainText("Configured");
    await expect(page.locator("#settings-api-key")).toHaveAttribute("type", "password");
    await expect(page.locator("#settings-api-key")).toHaveValue("");

    const oldUrl = await page.locator("dd code").nth(1).textContent();
    await page.getByLabel("Port").fill("5099");
    await page.getByRole("button", { name: "Save settings" }).click();

    await expect(page.getByText("Restart required.")).toBeVisible();
    await expect(page.getByText(`The current address is`)).toBeVisible();
    await expect(page.getByText(oldUrl ?? "").first()).toBeVisible();
  } finally {
    await app.close();
  }
});
