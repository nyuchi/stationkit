import { describe, expect, it } from "vitest";
import {
  isStationId,
  isStationKey,
  parseReadingInput,
  parseRegisterInput,
} from "./validators";

describe("parseRegisterInput", () => {
  const ok = {
    name: " Marondera High ",
    lat: "-18.18",
    lon: 31.55,
    stationType: "digital",
    country: "zw",
  };

  it("trims, coerces numeric strings and accepts a valid body", () => {
    const r = parseRegisterInput(ok);
    expect(r).toEqual({
      ok: true,
      value: {
        name: "Marondera High",
        lat: -18.18,
        lon: 31.55,
        stationType: "digital",
        country: "ZW",
      },
    });
  });

  it("requires a real country and upper-cases it: the API files an omitted one under ZW", () => {
    expect(parseRegisterInput({ ...ok, country: " ke " })).toMatchObject({
      ok: true,
      value: { country: "KE" },
    });
    const { country: _omitted, ...without } = ok;
    for (const bad of [
      without,
      { ...ok, country: "" },
      { ...ok, country: "ZZ" },
      { ...ok, country: "ZWE" },
      { ...ok, country: 7 },
      { ...ok, country: null },
    ]) {
      const r = parseRegisterInput(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/country/i);
    }
  });

  it("keeps trimmed hardware and drops blank hardware", () => {
    expect(
      parseRegisterInput({ ...ok, hardware: " Ecowitt WS2910 " }),
    ).toMatchObject({
      value: { hardware: "Ecowitt WS2910" },
    });
    const blank = parseRegisterInput({ ...ok, hardware: "  " });
    expect(blank.ok && "hardware" in blank.value).toBe(false);
  });

  it.each([
    [{ ...ok, name: "A" }, /name/i],
    [{ ...ok, name: "x".repeat(81) }, /name/i],
    [{ ...ok, lat: 91 }, /latitude/i],
    [{ ...ok, lat: "abc" }, /latitude/i],
    [{ ...ok, lon: -181 }, /longitude/i],
    [{ ...ok, stationType: "other" }, /type/i],
    [{ ...ok, hardware: "h".repeat(81) }, /hardware/i],
    [{ ...ok, hardware: 5 }, /hardware/i],
    [{ ...ok, hardware: ["x"] }, /hardware/i],
    [{ ...ok, hardware: "a\u0007b" }, /control/i],
    [{ ...ok, name: "Farm\nname" }, /control/i],
    [{ ...ok, name: "Farm\u0000" }, /control/i],
    [null, /json/i],
    [[], /json/i],
  ])("rejects %j", (input, message) => {
    const r = parseRegisterInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it("accepts the coordinate and length boundaries", () => {
    expect(
      parseRegisterInput({ ...ok, lat: 90, lon: -180, name: "ab" }).ok,
    ).toBe(true);
    expect(
      parseRegisterInput({ ...ok, lat: 0, lon: 0, name: "x".repeat(80) }).ok,
    ).toBe(true);
  });
});

describe("parseReadingInput", () => {
  it("keeps only provided measurements and coerces strings", () => {
    expect(
      parseReadingInput({ temperatureC: "21.5", rainfallMm: "", windKph: 3 }),
    ).toEqual({
      ok: true,
      value: { temperatureC: 21.5, windKph: 3 },
    });
  });

  it("ignores unknown fields", () => {
    expect(
      parseReadingInput({ temperatureC: 1, notes: "x", key: "secret" }),
    ).toEqual({
      ok: true,
      value: { temperatureC: 1 },
    });
  });

  it("requires at least one measurement", () => {
    expect(parseReadingInput({})).toMatchObject({
      ok: false,
      error: /at least one/i,
    });
  });

  it.each([
    ["temperatureC", -50.1],
    ["temperatureC", 60.1],
    ["rainfallMm", -1],
    ["rainfallMm", 500.1],
    ["humidityPercent", 100.1],
    ["pressureHpa", 799],
    ["pressureHpa", 1101],
    ["windKph", 250.1],
    ["windKph", "wind"],
  ])("rejects %s = %s", (field, value) => {
    expect(parseReadingInput({ [field]: value }).ok).toBe(false);
  });

  it("accepts every limit inclusively", () => {
    expect(
      parseReadingInput({
        temperatureC: -50,
        rainfallMm: 500,
        humidityPercent: 0,
        pressureHpa: 1100,
        windKph: 250,
      }).ok,
    ).toBe(true);
  });
});

describe("isStationId", () => {
  it("matches the backend id shape only", () => {
    expect(isStationId("mws-0a1b2c3d")).toBe(true);
    for (const bad of [
      "mws-0A1B2C3D",
      "mws-123",
      "MWS-0a1b2c3d",
      "mws-0a1b2c3d/../x",
      "",
      5,
      null,
    ]) {
      expect(isStationId(bad)).toBe(false);
    }
  });
});

describe("isStationKey", () => {
  it("accepts one token of visible ASCII, up to 256 characters", () => {
    expect(isStationKey("legacy-demo-key")).toBe(true);
    expect(isStationKey("Zk3_-9aB~.=")).toBe(true);
    expect(isStationKey("x".repeat(256))).toBe(true);
  });
  it.each([
    "",
    " ",
    "a b",
    "a\nb",
    "a\u0000b",
    "caf\u00e9",
    "x".repeat(257),
    5,
    null,
    undefined,
  ])("rejects %j", (v) => {
    expect(isStationKey(v)).toBe(false);
  });
});
