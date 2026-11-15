import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    headless: true,
    viewport: { width: 1280, height: 900 },
    actionTimeout: 10_000,
    trace: "off",
  },
});
