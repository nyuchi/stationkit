import { defineConfig, devices } from "@playwright/test";

// Browsers: locally Chromium may be preinstalled (PLAYWRIGHT_BROWSERS_PATH); CI
// installs it with `playwright install`. The smoke runs against the mock backend and the
// mock cookie session.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4321",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "AUTH_MODE=mock astro dev --ignore-lock --port 4321",
    url: "http://localhost:4321/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
