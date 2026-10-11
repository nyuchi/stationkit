import { describe, expect, it } from "vitest";
import { MockStationsClient } from "./stations/mock-client";
import { NyuchiStationsClient } from "./stations/nyuchi-client";
import {
  createStationsClient,
  DEFAULT_INGEST_HOST,
  DEFAULT_NYUCHI_API_URL,
  INGEST_PATH,
  resolveConfig,
} from "./config";

const dev = { prod: false };
const prod = { prod: true };

describe("resolveConfig", () => {
  it("defaults, in development, to the mock backend on Nyuchi's own hosts", () => {
    expect(resolveConfig({}, dev)).toEqual({
      backend: "mock",
      nyuchiApiUrl: "https://api.nyuchi.com",
      ingestHost: "weather-ingest.nyuchi.com",
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

describe("createStationsClient", () => {
  it("picks the client from config and shares one mock", () => {
    const a = createStationsClient(resolveConfig({}, dev));
    expect(a).toBeInstanceOf(MockStationsClient);
    expect(createStationsClient(resolveConfig({}, dev))).toBe(a);
    expect(
      createStationsClient(resolveConfig({ STATIONS_BACKEND: "nyuchi" }, dev)),
    ).toBeInstanceOf(NyuchiStationsClient);
  });
});
