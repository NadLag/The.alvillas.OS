import { defineConfig, devices } from "@playwright/test";

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
    env: { R2_ACCOUNT_ID: "alvillas-e2e-local", R2_BUCKET: "private-e2e-evidence", R2_ACCESS_KEY_ID: "local-e2e-access", R2_SECRET_ACCESS_KEY: "local-e2e-signing-fixture" },
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
