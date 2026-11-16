import { describe, expect, it } from "vitest";
import { COUNTRY_CODES, countryOptions, parseCountry } from "./countries";

describe("countries", () => {
  it("has the 249 ISO 3166-1 alpha-2 codes, once each", () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    for (const c of COUNTRY_CODES) expect(c).toMatch(/^[A-Z]{2}$/);
  });
  it("knows the countries stations are in, and every code has a name", () => {
    for (const c of [
      "ZW",
      "KE",
      "ZA",
      "ZM",
      "MZ",
      "BW",
      "MW",
      "TZ",
      "UG",
      "NG",
      "GH",
    ])
      expect(COUNTRY_CODES).toContain(c);
    const options = countryOptions();
    expect(options).toHaveLength(249);
    for (const o of options) expect(o.label, o.value).not.toBe(o.value);
    expect(options.find((o) => o.value === "ZW")?.label).toBe("Zimbabwe");
    expect(options.map((o) => o.label)).toEqual(
      [...options.map((o) => o.label)].sort((a, b) => a.localeCompare(b, "en")),
    );
  });
  it("accepts a known code in any case, and nothing else", () => {
    expect(parseCountry("zw")).toBe("ZW");
    expect(parseCountry(" Ke ")).toBe("KE");
    for (const bad of [
      "",
      "ZZ",
      "XX",
      "ZWE",
      "Z",
      "Zimbabwe",
      7,
      null,
      undefined,
      ["ZW"],
    ])
      expect(parseCountry(bad)).toBeNull();
  });
});
