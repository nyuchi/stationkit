import { describe, expect, it } from "vitest";
import { parseIngestHint, parseIngestSetup } from "./ingest";

const ok = { server: "weather-ingest.nyuchi.com", path: "/stations/ingest" };

describe("parseIngestHint", () => {
  it("keeps a host and a path, and drops anything else the API said about it", () => {
    expect(
      parseIngestHint({
        ...ok,
        params: "ID=<stationId>&PASSWORD=<ingestKey>",
        note: "x",
      }),
    ).toEqual(ok);
    expect(
      parseIngestHint({ server: "ingest.example.test:8443", path: "/in" }),
    ).toEqual({
      server: "ingest.example.test:8443",
      path: "/in",
    });
  });
  it.each([
    [{ server: "evil.test/<script>", path: "/x" }],
    [{ server: "a b.test", path: "/x" }],
    [{ server: "http://ingest.test", path: "/x" }],
    [{ server: "", path: "/x" }],
    [{ server: "ok.test", path: "stations/ingest" }],
    [{ server: "ok.test", path: "/x?y=1" }],
    [{ server: "ok.test", path: "/x#y" }],
    [{ server: "ok.test", path: "/x y" }],
    [{ server: "ok.test", path: "//evil.test" }],
    [{ server: "ok.test" }],
    [{ server: 5, path: "/x" }],
    ["text"],
    [null],
  ])("rejects %j", (v) => {
    expect(parseIngestHint(v)).toBeNull();
  });
});

describe("parseIngestSetup", () => {
  it("needs both protocols", () => {
    expect(parseIngestSetup({ wunderground: ok, ecowitt: ok })).toEqual({
      wunderground: ok,
      ecowitt: ok,
    });
    expect(parseIngestSetup({ wunderground: ok })).toBeNull();
    expect(
      parseIngestSetup({
        wunderground: ok,
        ecowitt: { server: "x y", path: "/" },
      }),
    ).toBeNull();
    expect(parseIngestSetup(undefined)).toBeNull();
  });
});
