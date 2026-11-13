import { describe, expect, it } from "vitest";
import { MockStationsClient } from "./stations/mock-client";
import { NyuchiStationsClient } from "./stations/nyuchi-client";
import {
  createStationsClient,
  DEFAULT_INGEST_HOST,
  DEFAULT_NYUCHI_API_URL,
  INGEST_PATH,
  resolveConfig,
  resolveCredentials,
} from "./config";

const dev = { prod: false };
const prod = { prod: true };

describe("resolveConfig", () => {
  it("defaults, in development, to the mock backend on Nyuchi's own hosts", () => {
    expect(resolveConfig({}, dev)).toEqual({
      backend: "mock",
      nyuchiApiUrl: "https://api.nyuchi.com",
      ingestHost: "weather-ingest.nyuchi.com",
      live: true,
    });
    expect(DEFAULT_NYUCHI_API_URL).toBe("https://api.nyuchi.com");
    expect(DEFAULT_INGEST_HOST).toBe("weather-ingest.nyuchi.com");
    expect(INGEST_PATH).toBe("/stations/ingest");
  });

  it("defaults, in production, to the Nyuchi backend", () => {
    expect(resolveConfig({}, prod).backend).toBe("nyuchi");
  });

  it("refuses the mock backend in production, however it is requested", () => {
    expect(() => resolveConfig({ STATIONS_BACKEND: "mock" }, prod)).toThrow(
      /not allowed in a production/,
    );
    expect(resolveConfig({ STATIONS_BACKEND: "mock" }, dev).backend).toBe(
      "mock",
    );
  });

  it("validates the API URL: absolute, https (or localhost), no trailing slash", () => {
    expect(() => resolveConfig({ NYUCHI_API_URL: "not a url" }, dev)).toThrow(
      /absolute/,
    );
    expect(() =>
      resolveConfig({ NYUCHI_API_URL: "http://api.example.test" }, dev),
    ).toThrow(/https/);
    expect(
      resolveConfig({ NYUCHI_API_URL: "https://api.example.test/base/" }, dev)
        .nyuchiApiUrl,
    ).toBe("https://api.example.test/base");
    expect(
      resolveConfig({ NYUCHI_API_URL: "http://localhost:8000" }, dev)
        .nyuchiApiUrl,
    ).toBe("http://localhost:8000");
  });

  it("rejects an unknown backend instead of silently mocking", () => {
    expect(() => resolveConfig({ STATIONS_BACKEND: "mongo" }, dev)).toThrow(
      /mock.*nyuchi/,
    );
  });

  it("validates the ingest host", () => {
    expect(
      resolveConfig({ NYUCHI_INGEST_HOST: "ingest.example.test" }, dev)
        .ingestHost,
    ).toBe("ingest.example.test");
    expect(() =>
      resolveConfig({ NYUCHI_INGEST_HOST: "evil.test/<script>" }, dev),
    ).toThrow(/host/);
  });
});

describe("the console's key", () => {
  const key = {
    NYUCHI_CONSOLE_CLIENT_ID: "nyk_test_id",
    NYUCHI_CONSOLE_CLIENT_SECRET: "nys_test_secret",
  };

  it("is read from the two Worker secrets, trimmed", () => {
    expect(
      resolveCredentials({
        NYUCHI_CONSOLE_CLIENT_ID: " nyk_test_id ",
        NYUCHI_CONSOLE_CLIENT_SECRET: "nys_test_secret\n",
      }),
    ).toEqual({ clientId: "nyk_test_id", clientSecret: "nys_test_secret" });
  });

  it("is null when neither is set: the Nyuchi backend is then not live, and says so", () => {
    expect(resolveCredentials({})).toBeNull();
    expect(resolveCredentials({ NYUCHI_CONSOLE_CLIENT_ID: " " })).toBeNull();
    expect(resolveConfig({ STATIONS_BACKEND: "nyuchi" }, prod).live).toBe(
      false,
    );
    expect(
      resolveConfig({ STATIONS_BACKEND: "nyuchi", ...key }, prod).live,
    ).toBe(true);
  });

  it("fails loudly when only one is set, or either is not a single token, and names no value", () => {
    for (const half of [
      { NYUCHI_CONSOLE_CLIENT_ID: "nyk_only_the_id" },
      { NYUCHI_CONSOLE_CLIENT_SECRET: "nys_only_the_secret" },
    ])
      expect(() =>
        resolveConfig({ STATIONS_BACKEND: "nyuchi", ...half }, prod),
      ).toThrow(/must be set together/);
    for (const bad of ["two words", "bad\nheader", "x".repeat(257)])
      expect(() =>
        resolveCredentials({ ...key, NYUCHI_CONSOLE_CLIENT_SECRET: bad }),
      ).toThrow(/single token/);
    try {
      resolveCredentials({ ...key, NYUCHI_CONSOLE_CLIENT_SECRET: "has space" });
    } catch (e) {
      expect(String(e)).not.toContain("has space");
      expect(String(e)).not.toContain("nyk_test_id");
    }
  });

  it("is never part of the config the page and the browser see", () => {
    const config = resolveConfig({ STATIONS_BACKEND: "nyuchi", ...key }, prod);
    expect(JSON.stringify(config)).not.toMatch(/nys_|nyk_|SECRET|CLIENT/);
  });
});

describe("createStationsClient", () => {
  it("picks the client from config and shares one mock", () => {
    const a = createStationsClient(resolveConfig({}, dev));
    expect(a).toBeInstanceOf(MockStationsClient);
    expect(createStationsClient(resolveConfig({}, dev))).toBe(a);
    expect(
      createStationsClient(resolveConfig({ STATIONS_BACKEND: "nyuchi" }, dev)),
    ).toBeInstanceOf(NyuchiStationsClient);
  });

  it("shares one Nyuchi client between requests, so exchanged tokens are kept, and makes a new one when the key or URL changes", () => {
    const config = resolveConfig({ STATIONS_BACKEND: "nyuchi" }, dev);
    const credentials = { clientId: "nyk_a", clientSecret: "nys_a" };
    const first = createStationsClient(config, { credentials });
    expect(createStationsClient(config, { credentials })).toBe(first);
    expect(
      createStationsClient(config, {
        credentials: { clientId: "nyk_a", clientSecret: "nys_b" },
      }),
    ).not.toBe(first);
    expect(
      createStationsClient(
        resolveConfig(
          {
            STATIONS_BACKEND: "nyuchi",
            NYUCHI_API_URL: "https://other.example.test",
          },
          dev,
        ),
        { credentials: { clientId: "nyk_a", clientSecret: "nys_b" } },
      ),
    ).not.toBe(first);
  });
});
