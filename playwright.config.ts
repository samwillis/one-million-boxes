import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: `./tests/e2e`,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: `html`,
  use: {
    baseURL: `http://127.0.0.1:5174`,
    trace: `on-first-retry`,
    screenshot: `only-on-failure`,
  },
  projects: [
    {
      name: `chromium`,
      use: { ...devices[`Desktop Chrome`] },
    },
    {
      name: `firefox`,
      use: { ...devices[`Desktop Firefox`] },
    },
    {
      name: `webkit`,
      use: { ...devices[`Desktop Safari`] },
    },
    {
      name: `Mobile Chrome`,
      use: { ...devices[`Pixel 5`] },
    },
    {
      name: `Mobile Safari`,
      use: { ...devices[`iPhone 13`] },
    },
  ],
  webServer: {
    command: `pnpm exec tsx scripts/test-server.ts`,
    url: `http://127.0.0.1:5174`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15000 },
    timeout: 120 * 1000,
  },
})
