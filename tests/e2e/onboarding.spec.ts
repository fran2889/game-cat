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

test("an ambiguous multi-Account selection warns and offers the picker without AccountName", async ({
  page,
}) => {
  const app = await startTestApp({ games: 5, noKey: true, ambiguousAccount: true });
  try {
    await page.goto(app.url);
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByTestId("ambiguous-account")).toBeVisible();
    await expect(
      page.getByTestId("ambiguous-account").getByText("Several Steam Accounts were found."),
    ).toBeVisible();
    await expect(
      page.getByTestId("ambiguous-account").getByRole("link", { name: "Choose Account" }),
    ).toHaveAttribute("href", "#steam-account");
    await expect(page.getByRole("radio")).toHaveCount(2);
    await expect(page.getByRole("radio", { name: /First Player/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Second Player/ })).toBeVisible();

    const body = await page.locator("body").innerText();
    expect(body).not.toContain("test-account");
    expect(body).not.toContain("fixture-account");
    expect(body).not.toContain("AccountName");
  } finally {
    await app.close();
  }
});

test("a configured Library warns about ambiguous Accounts and links to the picker", async ({
  page,
}) => {
  const app = await startTestApp({ games: 5, ambiguousAccount: true });
  try {
    await page.goto(app.url);
    await expect(page.getByTestId("ambiguous-account-warning")).toBeVisible();
    await page.getByRole("link", { name: "Choose Account" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("combobox", { name: "Steam Account" })).toBeVisible();
    await expect(page.getByRole("option", { name: /First Player/ })).toHaveCount(1);
    await expect(page.getByRole("option", { name: /Second Player/ })).toHaveCount(1);
  } finally {
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

test("settings rejects an invalid port and a relative Steam root before saving", async ({
  page,
}) => {
  const app = await startTestApp({ games: 5 });
  const patches: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "PATCH" && url.pathname === "/api/config") {
      patches.push(url.pathname);
    }
  });

  try {
    await page.goto(`${app.url}settings`);
    await page.getByLabel("Port").fill("70000");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Enter an integer between 0 and 65535.")).toBeVisible();

    await page.getByLabel("Port").fill("5099");
    await page.getByLabel("Steam root").fill("relative/steam");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Enter an absolute path to the Steam folder.")).toBeVisible();
    expect(patches).toEqual([]);
  } finally {
    await app.close();
  }
});

test("onboarding requires a key before Scan sends the first Fetch", async ({ page }) => {
  const app = await startTestApp({ games: 5, noKey: true });
  const configWrites: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "PATCH" && url.pathname === "/api/config") {
      configWrites.push(url.pathname);
    }
  });

  try {
    await page.goto(app.url);
    await expect(page).toHaveURL(/\/onboarding$/);
    await page.getByRole("button", { name: "Scan library" }).click();
    await expect(page.getByText("A Steam Web API key is required.")).toBeVisible();
    expect(configWrites).toEqual([]);
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
