/** Shared by playwright.nyuchi.config.ts and e2e/nyuchi.spec.ts. Throwaway values for the fake API. */
export const FAKE_PORT = 4410;
export const APP_PORT = 4322;
export const FAKE_URL = `http://localhost:${FAKE_PORT}`;
export const CONSOLE_KEY = {
  clientId: "nyk_e2e_console",
  clientSecret: "nys_e2e_console_secret",
} as const;
export const FAKE_INGEST_SERVER = "ingest.fake-nyuchi.test";
