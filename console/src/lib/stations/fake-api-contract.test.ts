import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EXAMPLE_PROBLEM,
  EXAMPLE_READINGS_OUT,
  EXAMPLE_REGISTERED,
  EXAMPLE_ROTATED,
  EXAMPLE_STATION,
  EXAMPLE_TOKEN,
  type FakeNyuchiApi,
  startFakeNyuchiApi,
} from "../../../e2e/support/fake-nyuchi-api";

/**
 * The fake stands in for the Nyuchi API in every other test, so it is held to
 * the contract's own examples: whatever it answers has exactly the keys of the
 * example for that route, and it keeps the rules the API documents. If the
 * fake drifted from the examples, the client tests would be testing a fiction.
 */
let api: FakeNyuchiApi;
beforeAll(async () => {
  api = await startFakeNyuchiApi({ knownUsers: ["alice", "bob"] });
});
afterAll(() => api.close());
beforeEach(() => api.reset());

const keys = (v: unknown) => Object.keys(v as Record<string, unknown>).sort();

async function call(
  method: string,
  path: string,
  init: { bearer?: string; json?: unknown; form?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {};
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  let body: string | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  const res = await fetch(`${api.url}${path}`, {
    method,
    headers,
    body: body ?? null,
  });
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    cache: res.headers.get("cache-control"),
    json: (await res.json()) as Record<string, any>,
  };
}

const exchange = async (user: string) =>
  (
    await call("POST", "/v1/auth/token", {
      form: {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: `authkit.${user}`,
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        scope: "stations",
        client_id: api.clientId,
        client_secret: api.clientSecret,
      },
    })
  ).json;

const register = {
  name: "Chinhoyi School",
  lat: -17.36,
  lon: 30.2,
  country: "ZW",
};

describe("the fake answers in the contract's shapes", () => {
  it("the token exchange has the example's keys, and the stations scope", async () => {
    const t = await exchange("alice");
    expect(keys(t)).toEqual(keys(EXAMPLE_TOKEN));
    expect(t.scope).toBe("stations");
    expect(t.token_type).toBe("Bearer");
    expect(t.issued_token_type).toBe(EXAMPLE_TOKEN.issued_token_type);
  });

  it("register, list, status, readings and rotate have the examples' keys", async () => {
    const bearer = (await exchange("alice")).access_token as string;
    const reg = await call("POST", "/v1/stations", { bearer, json: register });
    expect(reg.status).toBe(201);
    expect(keys(reg.json)).toEqual(keys(EXAMPLE_REGISTERED));
    expect(keys(reg.json.ingest)).toEqual(keys(EXAMPLE_REGISTERED.ingest));
    expect(keys(reg.json.ingest.wunderground)).toEqual(
      keys(EXAMPLE_REGISTERED.ingest.wunderground),
    );
    expect(keys(reg.json.ingest.ecowitt)).toEqual(
      keys(EXAMPLE_REGISTERED.ingest.ecowitt),
    );
    expect(reg.json.stationId).toMatch(/^mws-[a-f0-9]{8}$/);
    expect(reg.json.ingestKey).toHaveLength(32);
    expect(reg.json.location.type).toBe("Point");
    const id = reg.json.stationId as string;

    const list = await call("GET", "/v1/stations", { bearer });
    expect(keys(list.json)).toEqual(["count", "stations"]);
    expect(keys(list.json.stations[0])).toEqual(keys(EXAMPLE_STATION));
    // A list never carries a key.
    expect(JSON.stringify(list.json)).not.toContain(reg.json.ingestKey);

    const status = await call("GET", `/v1/stations/${id}`, { bearer });
    expect(keys(status.json)).toEqual(
      [...keys(EXAMPLE_STATION), "latestMetrics"].sort(),
    );
    expect(status.json.latestMetrics).toBeNull();

    const readings = await call("POST", `/v1/stations/${id}/readings`, {
      bearer,
      json: {
        stationType: "generic",
        readings: [
          { observedAt: new Date().toISOString(), temperatureC: 21.4 },
          { observedAt: new Date().toISOString(), temperatureC: 99 },
        ],
      },
    });
    expect(readings.status).toBe(200);
    expect(keys(readings.json)).toEqual(keys(EXAMPLE_READINGS_OUT));
    expect(keys(readings.json.results[0])).toEqual(
      keys(EXAMPLE_READINGS_OUT.results[0]),
    );
    expect(keys(readings.json.results[1])).toEqual(
      keys(EXAMPLE_READINGS_OUT.results[1]),
    );
    expect(keys(readings.json.errors[0])).toEqual(
      keys(EXAMPLE_READINGS_OUT.errors[0]),
    );
    expect(readings.json).toMatchObject({ accepted: 1, rejected: 1 });
    expect(readings.json.errors[0]).toMatchObject({
      index: 1,
      code: "out_of_range",
      field: "temperatureC",
    });
    // It names the field and never the value.
    expect(JSON.stringify(readings.json.errors)).not.toContain("99");

    const rotated = await call("POST", `/v1/stations/${id}/rotate-key`, {
      bearer,
    });
    expect(keys(rotated.json)).toEqual(keys(EXAMPLE_ROTATED));
  });

  it("errors are RFC 9457 problems with a code, and every station answer is no-store", async () => {
    const none = await call("GET", "/v1/stations");
    expect(none.status).toBe(401);
    expect(none.type).toContain("application/problem+json");
    expect(none.cache).toBe("no-store");
    for (const k of keys(EXAMPLE_PROBLEM))
      expect(none.json, k).toHaveProperty(k);
    expect(none.json).toMatchObject({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      instance: "/v1/stations",
      code: "authentication_required",
    });

    api.setUnavailable(true);
    const down = await call("GET", "/v1/stations");
    expect(keys(down.json)).toEqual(keys(EXAMPLE_PROBLEM));
    expect(down.json).toMatchObject(EXAMPLE_PROBLEM);
  });

  it("the exchange answers 404 person_not_found in the OAuth shape until the person is ensured", async () => {
    const miss = await exchange("stranger");
    expect(miss).toEqual({
      detail: {
        error: "person_not_found",
        error_description: expect.any(String),
      },
    });
    const ensure = await fetch(`${api.url}/v1/identity/persons/ensure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": api.clientId,
        "X-Client-Secret": api.clientSecret,
      },
      body: JSON.stringify({
        subject_token: "authkit.stranger",
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      }),
    });
    expect(ensure.status).toBe(201);
    expect(Object.keys(await ensure.json()).sort()).toEqual([
      "created",
      "person_id",
    ]);
    expect((await exchange("stranger")).access_token).toBeTruthy();
  });
});

describe("the fake keeps the rules the API documents", () => {
  it("a foreign station is a 404, the same as a missing one", async () => {
    const a = (await exchange("alice")).access_token as string;
    const b = (await exchange("bob")).access_token as string;
    const reg = await call("POST", "/v1/stations", {
      bearer: a,
      json: register,
    });
    const id = reg.json.stationId as string;
    const foreign = await call("GET", `/v1/stations/${id}`, { bearer: b });
    const missing = await call("GET", "/v1/stations/mws-ffffffff", {
      bearer: b,
    });
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    expect(foreign.json.code).toBe("station_not_found");
    expect(missing.json.code).toBe("station_not_found");
    expect(
      (await call("POST", `/v1/stations/${id}/rotate-key`, { bearer: b }))
        .status,
    ).toBe(404);
  });

  it("a key that opens nothing and a station that is not there are the same 401", async () => {
    const a = (await exchange("alice")).access_token as string;
    const reg = await call("POST", "/v1/stations", {
      bearer: a,
      json: register,
    });
    const wrong = await call("GET", `/v1/stations/${reg.json.stationId}`, {
      bearer: "not-the-key",
    });
    const absent = await call("GET", "/v1/stations/mws-ffffffff", {
      bearer: reg.json.ingestKey,
    });
    expect([wrong.status, absent.status]).toEqual([401, 401]);
    expect(wrong.json.code).toBe("invalid_credentials");
    expect(absent.json.code).toBe("invalid_credentials");
    // The key opens its own station, and nothing else (rotating is the owner's).
    expect(
      (
        await call("GET", `/v1/stations/${reg.json.stationId}`, {
          bearer: reg.json.ingestKey,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("POST", `/v1/stations/${reg.json.stationId}/rotate-key`, {
          bearer: reg.json.ingestKey,
        })
      ).status,
    ).toBe(401);
    expect(
      (await call("GET", "/v1/stations", { bearer: reg.json.ingestKey }))
        .status,
    ).toBe(401);
  });

  it("an omitted country is ZW, as the Worker has always assumed", async () => {
    const a = (await exchange("alice")).access_token as string;
    const { country: _country, ...noCountry } = register;
    const reg = await call("POST", "/v1/stations", {
      bearer: a,
      json: noCountry,
    });
    expect(reg.json.countryCode).toBe("ZW");
  });

  it("refuses extra fields, a soil moisture reading, and both wind units together", async () => {
    const a = (await exchange("alice")).access_token as string;
    const extra = await call("POST", "/v1/stations", {
      bearer: a,
      json: { ...register, ownerId: "x" },
    });
    expect(extra.status).toBe(422);
    const id = (
      await call("POST", "/v1/stations", { bearer: a, json: register })
    ).json.stationId as string;
    const soil = await call("POST", `/v1/stations/${id}/readings`, {
      bearer: a,
      json: { readings: [{ soilMoisturePct: 40 }] },
    });
    expect(soil.status).toBe(422);
    const both = await call("POST", `/v1/stations/${id}/readings`, {
      bearer: a,
      json: { readings: [{ windSpeedMs: 3, windSpeedKph: 11 }] },
    });
    expect(both.json.errors[0].code).toBe("conflicting_fields");
    expect(both.status).toBe(200);
    expect(both.json.accepted).toBe(0);
  });

  it("windSpeedKph is stored as sent; windSpeedMs is converted", async () => {
    const a = (await exchange("alice")).access_token as string;
    const id = (
      await call("POST", "/v1/stations", { bearer: a, json: register })
    ).json.stationId as string;
    await call("POST", `/v1/stations/${id}/readings`, {
      bearer: a,
      json: { readings: [{ windSpeedKph: 12.34 }] },
    });
    expect(
      (await call("GET", `/v1/stations/${id}`, { bearer: a })).json
        .latestMetrics,
    ).toEqual({ windSpeedKph: 12.34 });
  });

  it("only an internal key with the right pair may exchange, and only for the stations scope", async () => {
    const bad = await call("POST", "/v1/auth/token", {
      form: {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: "authkit.alice",
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        scope: "stations",
        client_id: api.clientId,
        client_secret: "wrong",
      },
    });
    expect(bad.status).toBe(401);
    expect(bad.json.detail.error).toBe("invalid_client");
    const wide = await call("POST", "/v1/auth/token", {
      form: {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: "authkit.alice",
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        scope: "stations admin",
        client_id: api.clientId,
        client_secret: api.clientSecret,
      },
    });
    expect(wide.json.detail.error).toBe("invalid_scope");
  });
});
