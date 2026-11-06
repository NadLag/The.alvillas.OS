import { defineConfig, devices } from "@playwright/test";
import { storageFixtureEnvironment } from "./tests/e2e/support/storage-fixture-config";

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "tests/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  workers: process.env.CI ? 1 : 2,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure"
  },
  webServer: {
    command: process.env.PLAYWRIGHT_PRODUCTION === "1"
      ? "node --import ./tests/e2e/support/storage-transport.mjs node_modules/next/dist/bin/next start --hostname=127.0.0.1 --port=3000"
      : "node --import ./tests/e2e/support/storage-transport.mjs node_modules/next/dist/bin/next dev --hostname=127.0.0.1 --port=3000",
    env: storageFixtureEnvironment,
    url: "http://127.0.0.1:3000/en",
    reuseExistingServer: !process.env.CI,
    timeout: 120000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "field-mobile",
      use: { ...devices["Pixel 5"] }
    }
  ]
});
