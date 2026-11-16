import { describe, expect, it } from "vitest";
import {
  failureCode,
  GENERIC_MESSAGE,
  mapIdentityFailure,
  mapStationFailure,
  NOT_LIVE_MESSAGE,
  RATE_LIMIT_MESSAGE,
  REJECTED_MESSAGE,
} from "./nyuchi-errors";

describe("failureCode", () => {
  it("reads an RFC 9457 problem's code and an OAuth error, and nothing else", () => {
    expect(failureCode({ code: "station_not_found", status: 404 })).toBe(
      "station_not_found",
    );
    expect(
      failureCode({
        detail: { error: "person_not_found", error_description: "x" },
      }),
    ).toBe("person_not_found");
    expect(failureCode({ error: "invalid_client" })).toBe("invalid_client");
  });
  it("ignores prose, lists and codes that are not codes", () => {
    for (const body of [
      null,
      "text",
      [],
      {},
      { detail: "Not authenticated" },
      { detail: [{ msg: "field required" }] },
      { code: "has spaces and \n newline" },
      { code: 7 },
      { code: "x".repeat(65) },
    ])
      expect(failureCode(body)).toBeNull();
  });
});

describe("mapStationFailure", () => {
  it.each([
    ["stations_unavailable", 503, 503, NOT_LIVE_MESSAGE],
    ["station_not_found", 404, 404, "Station not found"],
    [
      "station_limit_reached",
      409,
      409,
      "You already have the most stations one person can register.",
    ],
    ["invalid_station_key", 403, 403, "That is not this station's key."],
    ["rate_limited", 429, 429, RATE_LIMIT_MESSAGE],
    ["payload_too_large", 413, 400, REJECTED_MESSAGE],
  ])("%s (%i) becomes %i", (code, upstream, status, message) => {
    const e = mapStationFailure(upstream, code);
    expect([e.status, e.message]).toEqual([status, message]);
  });

  it.each([
    [404, 404],
    [429, 429],
    [400, 400],
    [413, 400],
    [422, 400],
    [401, 502],
    [403, 502],
    [409, 502],
    [500, 502],
    [502, 502],
    [503, 502],
    [301, 502],
    [204, 502],
  ])("a bare upstream %i becomes %i", (upstream, status) => {
    expect(mapStationFailure(upstream, null).status).toBe(status);
  });

  it("lets the code decide over the status", () => {
    expect(mapStationFailure(500, "stations_unavailable").message).toBe(
      NOT_LIVE_MESSAGE,
    );
  });

  it("never answers 401: that tells the browser the person is signed out", () => {
    for (const status of [401, 403, 500])
      for (const code of [
        null,
        "invalid_token",
        "invalid_credentials",
        "insufficient_scope",
        "person_required",
      ])
        expect(mapStationFailure(status, code).status).not.toBe(401);
    expect(mapStationFailure(401, "invalid_token").message).toBe(
      GENERIC_MESSAGE,
    );
  });
});

describe("mapIdentityFailure", () => {
  it("never answers 401, whatever the exchange said", () => {
    for (const [status, code] of [
      [401, "invalid_client"],
      [400, "invalid_grant"],
      [400, "unauthorized_client"],
      [400, "invalid_scope"],
      [403, "unauthorized_client"],
    ] as const)
      expect(mapIdentityFailure(status, code).status).not.toBe(401);
  });
  it("tells a person to sign in again only when their own sign-in is what failed", () => {
    expect(mapIdentityFailure(400, "invalid_grant").message).toMatch(
      /sign in again/,
    );
    expect(mapIdentityFailure(401, "invalid_client").message).toBe(
      GENERIC_MESSAGE,
    );
    expect(mapIdentityFailure(400, "invalid_scope").message).toBe(
      GENERIC_MESSAGE,
    );
  });
  it("passes on a rate limit and a temporary outage", () => {
    expect(mapIdentityFailure(429, "slow_down").status).toBe(429);
    expect(mapIdentityFailure(503, "temporarily_unavailable").status).toBe(503);
  });
});
