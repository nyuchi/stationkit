import { describe, expect, it } from "vitest";
import { INGEST_PATH } from "../ingest";
import {
  describeLastReading,
  describeReadingResult,
  formatMetrics,
  mergeStations,
  metricLabel,
  setupInstructions,
} from "./view-model";

const server = [
  {
    stationId: "mws-00000001",
    name: "Owned",
    stationType: "digital" as const,
    status: "active",
    lastObservationAt: null,
  },
];
const local = [
  {
    stationId: "mws-00000001",
    key: "saved",
    name: "Owned (old name)",
    stationType: "digital" as const,
  },
  {
    stationId: "mws-00000002",
    key: "legacy",
    name: "Legacy",
    stationType: "manual" as const,
  },
];

describe("mergeStations", () => {
  it("lists server stations first, attaches saved keys, and keeps key-only ones", () => {
    expect(mergeStations(server, local)).toEqual([
      {
        stationId: "mws-00000001",
        name: "Owned",
        stationType: "digital",
        access: "owner",
        key: "saved",
      },
      {
        stationId: "mws-00000002",
        name: "Legacy",
        stationType: "manual",
        access: "key",
        key: "legacy",
      },
    ]);
  });
  it("works with an empty server list or an empty browser", () => {
    expect(mergeStations([], local).every((s) => s.access === "key")).toBe(
      true,
    );
    expect(mergeStations(server, [])[0]).toMatchObject({
      access: "owner",
      key: undefined,
    });
  });
});

describe("setupInstructions", () => {
  it("uses the configured host and the fixed ingest path hardware already uses", () => {
    expect(INGEST_PATH).toBe("/stations/ingest");
    const i = setupInstructions("weather-ingest.nyuchi.com", "mws-0a0a0a0a");
    expect(i.wunderground).toContain(
      "server weather-ingest.nyuchi.com, path /stations/ingest",
    );
    expect(i.wunderground).toContain("ID = mws-0a0a0a0a");
    expect(i.ecowitt).toContain("PASSKEY = mws-0a0a0a0a:<your ingest key>");
  });
  it("shows what the API said, per protocol, instead of the configured host", () => {
    const i = setupInstructions("weather-ingest.nyuchi.com", "mws-0a0a0a0a", {
      wunderground: { server: "wu.example.test", path: "/in/wu" },
      ecowitt: { server: "ec.example.test", path: "/in/ec" },
    });
    expect(i.wunderground).toContain("server wu.example.test, path /in/wu");
    expect(i.ecowitt).toContain("server ec.example.test, path /in/ec");
    expect(JSON.stringify(i)).not.toContain("weather-ingest.nyuchi.com");
  });
  it("falls back to the configured host when the API said nothing, as for a rotated key", () => {
    const i = setupInstructions("h.example.test", "mws-0a0a0a0a", null);
    expect(i.wunderground).toContain(
      "server h.example.test, path /stations/ingest",
    );
  });
  it("never embeds the key", () => {
    expect(
      JSON.stringify(setupInstructions("h.test", "mws-0a0a0a0a")),
    ).not.toMatch(/secret/);
  });
});

describe("formatting", () => {
  it("humanises metric names", () => {
    expect(metricLabel("airTemperatureCelsius")).toBe(
      "air temperature celsius",
    );
    expect(formatMetrics({ windSpeedKph: 4, uvIndex: 2 })).toBe(
      "wind speed kph: 4 · uv index: 2",
    );
    expect(formatMetrics(null)).toBe("");
  });
  it("describes the last reading", () => {
    expect(describeLastReading(null)).toBe("No readings yet");
    expect(describeLastReading("garbage")).toBe("No readings yet");
    expect(describeLastReading("2026-10-11T08:00:00Z", "en-GB")).toMatch(
      /^Last reading /,
    );
  });
  it("describes QC outcomes", () => {
    expect(describeReadingResult({ qcStatus: "validated" }, 3)).toBe(
      "Saved. 3 measurement(s) accepted",
    );
    expect(describeReadingResult({ qcStatus: "rejected" }, 3)).toBe(
      "Rejected by quality checks",
    );
    expect(
      describeReadingResult(
        {
          qcStatus: "rejected",
          problems: [
            { field: "temperatureC", code: "out_of_range" },
            { field: "windKph", code: "conflicting_fields" },
            { field: "temperatureC", code: "out_of_range" },
            { field: null, code: "no_measurement" },
          ],
        },
        3,
      ),
    ).toBe(
      "Rejected by quality checks: temperature is out of range; wind was not accepted",
    );
  });
});
