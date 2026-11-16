import { defineConfig, devices } from "@playwright/test";
import {
  APP_PORT,
  CONSOLE_KEY,
  FAKE_INGEST_SERVER,
  FAKE_PORT,
  FAKE_URL,
} from "./e2e/support/e2e-env";

// The real Nyuchi client, end to end: the console runs with
// STATIONS_BACKEND=nyuchi against a fake Nyuchi API
// (e2e/support/fake-nyuchi-api.ts) built from the API's OpenAPI examples. No
// network to production. Sign-in is the mock cookie session; its access token
// is one per person, which the fake exchanges as the API exchanges AuthKit's.
//
// Run with `npm run test:e2e:nyuchi`. Chromium is the same as for `test:e2e`.
export default defineConfig({
  testDir: "e2e",
  testMatch: "nyuchi.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      // Node runs the TypeScript directly (type stripping).
      command: `node --experimental-strip-types --disable-warning=ExperimentalWarning e2e/support/fake-nyuchi-api.ts --port ${FAKE_PORT}`,
      url: `${FAKE_URL}/__fake/stats`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        FAKE_CLIENT_ID: CONSOLE_KEY.clientId,
        FAKE_CLIENT_SECRET: CONSOLE_KEY.clientSecret,
        FAKE_INGEST_SERVER,
      },
    },
    {
      // Writes .dev.vars (the dev runtime reads it ahead of wrangler.jsonc),
      // runs `astro dev` with the mock session, and puts .dev.vars back.
      command: "node e2e/support/start-console-nyuchi.mjs",
      url: `http://localhost:${APP_PORT}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      env: {
        E2E_APP_PORT: String(APP_PORT),
        E2E_API_URL: FAKE_URL,
        E2E_CLIENT_ID: CONSOLE_KEY.clientId,
        E2E_CLIENT_SECRET: CONSOLE_KEY.clientSecret,
      },
    },
  ],
});
