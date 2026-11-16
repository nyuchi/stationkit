import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  EXAMPLE_READINGS_OUT,
  EXAMPLE_REGISTERED,
  EXAMPLE_ROTATED,
  EXAMPLE_STATION,
  type FakeNyuchiApi,
  startFakeNyuchiApi,
} from "../../../e2e/support/fake-nyuchi-api";
import {
  API_ROUTES,
  NOT_LIVE_MESSAGE,
  NyuchiStationsClient,
  REQUEST_TIMEOUT_MS,
  toApiReading,
} from "./nyuchi-client";
import { UNAVAILABLE_MESSAGE } from "./nyuchi-errors";
import { type Caller, StationsApiError } from "./types";

/**
 * The real client against a fake Nyuchi API (e2e/support/fake-nyuchi-api.ts)
 * that answers in the shapes the API's OpenAPI contract documents. Real HTTP
 * on a local port: no network to production.
 */
let api: FakeNyuchiApi;
beforeAll(async () => {
  api = await startFakeNyuchiApi({
    knownUsers: ["alice", "bob"],
    registrationLimit: 3,
  });
});
afterAll(() => api.close());
beforeEach(() => api.reset());

const alice: Caller = {
  personId: "workos-alice",
  email: "alice@example.test",
  accessToken: "authkit.alice",
};
const bob: Caller = {
  personId: "workos-bob",
  email: "bob@example.test",
  accessToken: "authkit.bob",
};
const stranger: Caller = {
  personId: "workos-stranger",
  email: "s@example.test",
  accessToken: "authkit.stranger",
};

const place = {
  name: "Chinhoyi School",
  lat: -17.36,
  lon: 30.2,
  stationType: "digital",
  country: "ZW",
} as const;

function make(over: { now?: () => number; fetchImpl?: typeof fetch } = {}) {
  return new NyuchiStationsClient(api.url, {
    credentials: { clientId: api.clientId, clientSecret: api.clientSecret },
    ...over,
  });
}

const fail = async (p: Promise<unknown>): Promise<StationsApiError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(StationsApiError);
  return e as StationsApiError;
};

const stationRequests = () =>
  api.requests.filter((r) => r.path.startsWith("/v1/stations"));

describe("identity: the person's token (RFC 8693)", () => {
  it("exchanges the AuthKit token with the console's key for scope stations, then calls with the result", async () => {
    await make().list(alice);
    const [exchange, list] = api.requests;
    expect(exchange).toMatchObject({
      method: "POST",
      path: "/v1/auth/token",
      contentType: "application/x-www-form-urlencoded",
      clientIdHeader: api.clientId,
      clientSecretHeader: api.clientSecret,
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: "authkit.alice",
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        scope: "stations",
        client_id: api.clientId,
        client_secret: api.clientSecret,
      },
    });
    expect(list?.as).toBe("person");
    expect(list?.authorization).toMatch(/^Bearer ptok\./);
    // Neither the AuthKit token nor the console's key travels to /v1/stations.
    const sent = JSON.stringify(stationRequests());
    expect(sent).not.toContain("authkit.alice");
    expect(sent).not.toContain(api.clientSecret);
    expect(api.requests).toHaveLength(2);
  });

  it("keeps the exchanged token until it expires, and exchanges again only then", async () => {
    let t = 1_000_000;
    const client = make({ now: () => t });
    await client.list(alice);
    await client.list(alice);
    expect(api.stats.exchanges).toBe(1);
    t += 14 * 60_000; // 14 of its 15 minutes
    await client.list(alice);
    expect(api.stats.exchanges).toBe(1);
    t += 60_000; // past 15 minutes less the safety margin
    await client.list(alice);
    expect(api.stats.exchanges).toBe(2);
  });

  it("never keeps a token that is about to expire", async () => {
    const short = await startFakeNyuchiApi({
      knownUsers: ["alice"],
      tokenLifetimeSeconds: 20,
    });
    try {
      const client = new NyuchiStationsClient(short.url, {
        credentials: {
          clientId: short.clientId,
          clientSecret: short.clientSecret,
        },
      });
      await client.list(alice);
      await client.list(alice);
      expect(short.stats.exchanges).toBe(2);
    } finally {
      await short.close();
    }
  });

  it("shares one exchange between requests that arrive together", async () => {
    const client = make();
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => client.list(alice)));
    expect(api.stats.exchanges).toBe(1);
  });

  it("gives each person their own token and their own stations", async () => {
    const client = make();
    const mine = await client.register(alice, place);
    await client.register(bob, { ...place, name: "Bob's farm" });
    expect(api.stats.exchanges).toBe(2);
    expect((await client.list(alice)).map((s) => s.stationId)).toEqual([
      mine.stationId,
    ]);
    expect(await client.list(bob)).toHaveLength(1);
    const tokens = new Set(stationRequests().map((r) => r.authorization));
    expect(tokens.size).toBe(2);
  });

  it("provisions a person who has no record, once, and exchanges again", async () => {
    const client = make();
    await client.list(stranger);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/auth/token",
      "POST /v1/identity/persons/ensure",
      "POST /v1/auth/token",
      "GET /v1/stations",
    ]);
    expect(api.requests[1]).toMatchObject({
      contentType: "application/json",
      clientIdHeader: api.clientId,
      clientSecretHeader: api.clientSecret,
      body: {
        subject_token: "authkit.stranger",
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      },
    });
    // Provisioned: the next call neither provisions nor exchanges.
    await client.list(stranger);
    expect(api.stats).toMatchObject({ exchanges: 2, ensures: 1 });
  });

  it("does not provision twice when the person is still not found", async () => {
    api.queueFault({
      method: "POST",
      path: "/v1/auth/token",
      status: 404,
      code: "person_not_found",
      oauth: true,
      times: 2,
    });
    const e = await fail(make().list(alice));
    expect(e.status).toBe(502);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/auth/token",
      "POST /v1/identity/persons/ensure",
      "POST /v1/auth/token",
    ]);
  });

  it("answers a fixed message when the sign-in cannot be verified, and does not cache the failure", async () => {
    const client = make();
    const e = await fail(
      client.list({ ...alice, accessToken: "bogus-token-value" }),
    );
    expect(e.message).toBe(
      "The station service could not verify your sign-in. Sign out and sign in again.",
    );
    expect(e.message).not.toContain("bogus-token-value");
    // Not a 401: the browser signs people in again on a 401, and a console
    // whose own key is wrong would send everyone round in a circle.
    expect(e.status).toBe(502);
    await fail(client.list({ ...alice, accessToken: "bogus-token-value" }));
    expect(api.stats.exchanges).toBe(2);
  });

  it("refuses a person whose email is not verified, in words they can act on", async () => {
    api.queueFault({
      method: "POST",
      path: "/v1/identity/persons/ensure",
      status: 403,
      code: "email_not_verified",
      oauth: true,
    });
    const e = await fail(make().list(stranger));
    expect(e).toMatchObject({
      status: 403,
      message: "Verify your email address, then sign in again.",
    });
    expect(stationRequests()).toHaveLength(0);
  });

  it("exchanges once more when the API no longer accepts a cached token, and only once", async () => {
    const client = make();
    await client.list(alice);
    expect(api.stats.exchanges).toBe(1);
    api.queueFault({
      method: "GET",
      path: "/v1/stations",
      status: 401,
      code: "invalid_token",
    });
    expect(await client.list(alice)).toEqual([]);
    expect(api.stats.exchanges).toBe(2);
    expect(stationRequests().map((r) => r.method)).toEqual([
      "GET",
      "GET",
      "GET",
    ]);
  });

  it("does not retry a 401 for a token it has just been given", async () => {
    api.queueFault({
      method: "GET",
      path: "/v1/stations",
      status: 401,
      code: "invalid_token",
      times: 5,
    });
    const e = await fail(make().list(alice));
    expect(e.status).toBe(502);
    expect(api.stats.exchanges).toBe(1);
    expect(stationRequests()).toHaveLength(1);
  });

  it("answers 'not live yet' without a network call when the console has no key", async () => {
    const keyless = new NyuchiStationsClient(api.url, { credentials: null });
    for (const call of [
      () => keyless.register(alice, place),
      () => keyless.list(alice),
      () => keyless.status(alice, "mws-0a0a0a0a"),
      () => keyless.rotateKey(alice, "mws-0a0a0a0a"),
      () => keyless.claim(alice, "mws-0a0a0a0a", { stationKey: "k" }),
    ]) {
      const e = await fail(call());
      expect(e).toMatchObject({ status: 503, message: NOT_LIVE_MESSAGE });
    }
    expect(api.requests).toHaveLength(0);
  });

  it("still opens a station's own status and readings with its key when the console has no key", async () => {
    const { stationId, ingestKey } = await make().register(alice, place);
    api.requests.length = 0;
    const keyless = new NyuchiStationsClient(api.url, { credentials: null });
    expect(
      (await keyless.status(bob, stationId, { stationKey: ingestKey }))
        .stationId,
    ).toBe(stationId);
    const r = await keyless.submitReading(
      bob,
      stationId,
      { temperatureC: 20 },
      { stationKey: ingestKey },
    );
    expect(r.qcStatus).toBe("validated");
    expect(api.requests.map((x) => x.as)).toEqual([
      "station-key",
      "station-key",
    ]);
    expect(api.stats.exchanges).toBe(1); // alice's registration only
  });

  it("asks the browser to sign in again when there is no session token at all", async () => {
    const e = await fail(make().list({ personId: "p", email: "" }));
    expect(e.status).toBe(401);
    expect(api.requests).toHaveLength(0);
  });
});

describe("register", () => {
  it("sends the country and only the fields the API takes", async () => {
    await make().register(alice, { ...place, hardware: "Ecowitt GW1100" });
    expect(stationRequests()[0]?.body).toEqual({
      ...place,
      hardware: "Ecowitt GW1100",
    });
    await make().register(alice, { ...place, country: "KE" });
    expect(stationRequests()[1]?.body).toMatchObject({ country: "KE" });
    expect(stationRequests()[1]?.body).not.toHaveProperty("hardware");
  });

  it("returns the key once, with the upload target the API named", async () => {
    const r = await make().register(alice, place);
    expect(r.stationId).toMatch(/^mws-[a-f0-9]{8}$/);
    expect(r.ingestKey.length).toBeGreaterThanOrEqual(30);
    expect(r.stationType).toBe("digital");
    // From the API, not from this app: the fake names a host nobody hard-codes.
    expect(r.ingest).toEqual({
      wunderground: {
        server: "ingest.fake-nyuchi.test",
        path: "/stations/ingest",
      },
      ecowitt: { server: "ingest.fake-nyuchi.test", path: "/stations/ingest" },
    });
    expect(JSON.stringify(r)).not.toContain("PASSWORD=");
  });

  it("files the station under the country it was registered with", async () => {
    await make().register(alice, { ...place, country: "KE" });
    expect([...api.stations.values()].map((s) => s.countryCode)).toEqual([
      "KE",
    ]);
  });

  it("says plainly when a person has the most stations they may", async () => {
    const full = await startFakeNyuchiApi({
      knownUsers: ["alice"],
      maxStations: 1,
    });
    try {
      const client = new NyuchiStationsClient(full.url, {
        credentials: {
          clientId: full.clientId,
          clientSecret: full.clientSecret,
        },
      });
      await client.register(alice, place);
      const e = await fail(client.register(alice, place));
      expect(e).toMatchObject({
        status: 409,
        message: "You already have the most stations one person can register.",
      });
    } finally {
      await full.close();
    }
  });

  it("maps the registration rate limit to 429", async () => {
    const client = make();
    for (let i = 0; i < 3; i++) await client.register(alice, place);
    const e = await fail(client.register(alice, place));
    expect(e).toMatchObject({
      status: 429,
      message: "Too many requests. Try again later.",
    });
  });

  it("keeps today's 'not live yet' message while the API says its stations are not available", async () => {
    api.setUnavailable(true);
    const e = await fail(make().register(alice, place));
    expect(e).toMatchObject({ status: 503, message: NOT_LIVE_MESSAGE });
    expect((await fail(make().list(alice))).message).toBe(NOT_LIVE_MESSAGE);
  });
});

describe("list and status", () => {
  it("lists only the caller's stations, and only what the console shows", async () => {
    const client = make();
    const { stationId } = await client.register(alice, {
      ...place,
      hardware: "Ecowitt",
    });
    await client.register(bob, place);
    expect(await client.list(alice)).toEqual([
      {
        stationId,
        name: "Chinhoyi School",
        stationType: "digital",
        status: "active",
        lastObservationAt: null,
      },
    ]);
  });

  it("answers a foreign station as not found, the same as a missing one", async () => {
    const client = make();
    const { stationId } = await client.register(bob, place);
    const foreign = await fail(client.status(alice, stationId));
    const missing = await fail(client.status(alice, "mws-ffffffff"));
    expect(foreign).toMatchObject({
      status: 404,
      message: "Station not found",
    });
    expect(missing.message).toBe(foreign.message);
    expect((await fail(client.rotateKey(alice, stationId))).status).toBe(404);
    expect(
      (await fail(client.submitReading(alice, stationId, { temperatureC: 20 })))
        .status,
    ).toBe(404);
  });

  it("reads status for the owner, with the latest metrics by stored name", async () => {
    const client = make();
    const { stationId } = await client.register(alice, place);
    expect((await client.status(alice, stationId)).latestMetrics).toBeNull();
    await client.submitReading(alice, stationId, {
      temperatureC: 21.5,
      humidityPercent: 63,
      windKph: 12.34,
    });
    const s = await client.status(alice, stationId);
    expect(s.latestMetrics).toEqual({
      airTemperatureCelsius: 21.5,
      relativeHumidityPercent: 63,
      windSpeedKph: 12.34,
    });
    expect(s.lastObservationAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it("reads status with a station's key alone: no token exchange, the key as the bearer, never in the URL", async () => {
    const { stationId, ingestKey } = await make().register(alice, place);
    api.requests.length = 0;
    api.stats.exchanges = 0;
    const s = await make().status(stranger, stationId, {
      stationKey: ingestKey,
    });
    expect(s.stationId).toBe(stationId);
    expect(api.stats.exchanges).toBe(0);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({
      as: "station-key",
      authorization: `Bearer ${ingestKey}`,
      url: `/v1/stations/${stationId}`,
    });
  });

  it("says a station key was not accepted, whether the key or the station is wrong", async () => {
    const { stationId, ingestKey } = await make().register(alice, place);
    const wrongKey = await fail(
      make().status(alice, stationId, { stationKey: "not-the-key" }),
    );
    const wrongStation = await fail(
      make().status(alice, "mws-ffffffff", { stationKey: ingestKey }),
    );
    expect(wrongKey).toMatchObject({
      status: 403,
      message: "That station key was not accepted.",
    });
    expect(wrongStation.message).toBe(wrongKey.message);
  });

  it("encodes a station id into one path segment (the BFF has already checked it is an id)", async () => {
    await fail(make().status(alice, "../../v1/auth/token"));
    expect(stationRequests().at(-1)?.url).toContain(
      "..%2F..%2Fv1%2Fauth%2Ftoken",
    );
    expect(
      api.requests.some(
        (r) => r.path === "/v1/auth/token" && r.method === "GET",
      ),
    ).toBe(false);
  });
});

describe("manual readings", () => {
  it("sends one reading in the API's names, wind in km/h as collected, and no time of its own", async () => {
    const client = make();
    const { stationId } = await client.register(alice, place);
    const r = await client.submitReading(alice, stationId, {
      temperatureC: 21.5,
      humidityPercent: 60,
      pressureHpa: 1013.2,
      rainfallMm: 0,
      windKph: 12.34,
    });
    expect(r).toEqual({
      accepted: 1,
      rejected: 0,
      qcStatus: "validated",
      problems: [],
    });
    expect(stationRequests().at(-1)).toMatchObject({
      method: "POST",
      path: `/v1/stations/${stationId}/readings`,
      body: {
        stationType: "generic",
        readings: [
          {
            temperatureC: 21.5,
            humidityPct: 60,
            pressureHpa: 1013.2,
            rainfallMm: 0,
            windSpeedKph: 12.34,
          },
        ],
      },
    });
    // Converting to m/s and back would have stored 12.35.
    expect(
      (await client.status(alice, stationId)).latestMetrics?.windSpeedKph,
    ).toBe(12.34);
  });

  it("reports a reading out of range as rejected, with the field and no value", async () => {
    const client = make();
    const { stationId } = await client.register(alice, place);
    const r = await client.submitReading(alice, stationId, {
      temperatureC: 99.5,
    });
    expect(r).toEqual({
      accepted: 0,
      rejected: 1,
      qcStatus: "rejected",
      problems: [{ field: "temperatureC", code: "out_of_range" }],
    });
    expect(JSON.stringify(r)).not.toContain("99.5");
    expect(
      (await client.status(alice, stationId)).lastObservationAt,
    ).toBeNull();
  });

  it("opens with the station's own key, for someone who does not own it", async () => {
    const { stationId, ingestKey } = await make().register(alice, place);
    const r = await make().submitReading(
      stranger,
      stationId,
      { rainfallMm: 3 },
      { stationKey: ingestKey },
    );
    expect(r.qcStatus).toBe("validated");
    expect(stationRequests().at(-1)?.as).toBe("station-key");
    expect(
      (
        await fail(
          make().submitReading(
            stranger,
            stationId,
            { rainfallMm: 3 },
            { stationKey: "wrong" },
          ),
        )
      ).status,
    ).toBe(403);
  });

  it("maps the console's fields to the API's, and nothing else", () => {
    expect(
      toApiReading({
        windKph: 18,
        pressureHpa: 1013.2,
        rainfallMm: 0,
        humidityPercent: 40,
        temperatureC: -2,
      }),
    ).toEqual({
      windSpeedKph: 18,
      pressureHpa: 1013.2,
      rainfallMm: 0,
      humidityPct: 40,
      temperatureC: -2,
    });
    expect(toApiReading({})).toEqual({});
  });
});

describe("rotate the key", () => {
  it("returns the new key once; the old key stops and the new one works", async () => {
    const client = make();
    const { stationId, ingestKey } = await client.register(alice, place);
    const rotated = await client.rotateKey(alice, stationId);
    expect(rotated.stationId).toBe(stationId);
    expect(rotated.ingestKey).not.toBe(ingestKey);
    // The API sends no upload target on rotation: the console's own stands in.
    expect(rotated.ingest).toBeUndefined();
    expect(
      (
        await fail(
          make().status(stranger, stationId, { stationKey: ingestKey }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await make().status(stranger, stationId, {
          stationKey: rotated.ingestKey,
        })
      ).stationId,
    ).toBe(stationId);
  });

  it("is the owner's alone", async () => {
    const { stationId } = await make().register(alice, place);
    expect((await fail(make().rotateKey(bob, stationId))).status).toBe(404);
  });
});

describe("claim a legacy station", () => {
  const legacy = { stationId: "mws-00000001", key: "legacy-station-key" };
  beforeEach(() => api.seedCommunityStation(legacy));

  it("needs the right key; then the station is the caller's, and the key still works", async () => {
    const client = make();
    const wrong = await fail(
      client.claim(alice, legacy.stationId, { stationKey: "wrong" }),
    );
    expect(wrong).toMatchObject({
      status: 403,
      message: "That is not this station's key.",
    });
    expect(await client.list(alice)).toEqual([]);

    const claimed = await client.claim(alice, legacy.stationId, {
      stationKey: legacy.key,
    });
    expect(claimed).toMatchObject({
      stationId: legacy.stationId,
      name: "Legacy station",
    });
    expect((await client.list(alice)).map((s) => s.stationId)).toEqual([
      legacy.stationId,
    ]);
    expect((await client.status(alice, legacy.stationId)).stationId).toBe(
      legacy.stationId,
    );
    expect(
      (
        await client.status(stranger, legacy.stationId, {
          stationKey: legacy.key,
        })
      ).stationId,
    ).toBe(legacy.stationId);
    // The proof goes in the body the API expects, never in the URL.
    const claims = stationRequests().filter((r) => r.path.endsWith("/claim"));
    expect(claims[0]?.body).toEqual({ ingestKey: "wrong" });
    for (const c of claims) expect(c.url).not.toMatch(/wrong|legacy-station/);
  });

  it("changes nothing when claimed again, and is a 404 for anyone else", async () => {
    const client = make();
    await client.claim(alice, legacy.stationId, { stationKey: legacy.key });
    expect(
      (
        await client.claim(alice, legacy.stationId, {
          stationKey: legacy.key,
        })
      ).stationId,
    ).toBe(legacy.stationId);
    const e = await fail(
      client.claim(bob, legacy.stationId, { stationKey: legacy.key }),
    );
    expect(e).toMatchObject({
      status: 404,
      message: "This station cannot be claimed",
    });
    expect(
      (await fail(client.claim(bob, "mws-ffffffff", { stationKey: "k" })))
        .status,
    ).toBe(404);
  });

  it("will not claim without a key", async () => {
    const e = await fail(make().claim(alice, legacy.stationId, {}));
    expect(e.status).toBe(400);
    expect(api.requests).toHaveLength(0);
  });
});

describe("what leaves the app, and what stays out of sight", () => {
  it("sends every request to the Nyuchi API's own routes, without redirects, with a timeout", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const spy: typeof fetch = (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return fetch(input, init);
    };
    const client = make({ fetchImpl: spy });
    api.seedCommunityStation({
      stationId: "mws-00000001",
      key: "legacy-station-key",
    });
    const { stationId, ingestKey } = await client.register(alice, place);
    await client.list(alice);
    await client.status(alice, stationId);
    await client.submitReading(alice, stationId, { temperatureC: 20 });
    await client.status(stranger, stationId, { stationKey: ingestKey });
    await client.rotateKey(alice, stationId);
    await client.claim(alice, "mws-00000001", {
      stationKey: "legacy-station-key",
    });
    await make({ fetchImpl: spy }).list(stranger); // the provisioning path

    expect(seen.length).toBeGreaterThan(8);
    const routes = API_ROUTES.map((r) => {
      const [method, path] = r.split(" ") as [string, string];
      return {
        method,
        pattern: new RegExp(
          `^${path.replace("{stationId}", "mws-[a-f0-9]{8}")}$`,
        ),
      };
    });
    for (const { url, init } of seen) {
      expect(url.startsWith(`${api.url}/v1/`), url).toBe(true);
      const path = url.slice(api.url.length);
      expect(
        routes.some((r) => r.method === init.method && r.pattern.test(path)),
        `${init.method} ${path}`,
      ).toBe(true);
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(url).not.toContain("?");
    }
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  describe("the ingest key, the station key and the tokens", () => {
    const out: string[] = [];
    beforeEach(() => {
      out.length = 0;
      for (const method of ["log", "info", "debug", "warn", "error"] as const)
        vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
          out.push(a.map(String).join(" "));
        });
      for (const stream of [process.stdout, process.stderr])
        vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
          out.push(String(chunk));
          return true;
        });
    });
    afterEach(() => vi.restoreAllMocks());

    it("appear in no log, and in no answer except the one that issues them", async () => {
      const client = make();
      api.seedCommunityStation({
        stationId: "mws-00000001",
        key: "legacy-station-key",
      });
      const registered = await client.register(alice, place);
      const answers: unknown[] = [];
      answers.push(await client.list(alice));
      answers.push(await client.status(alice, registered.stationId));
      answers.push(
        await client.submitReading(alice, registered.stationId, {
          temperatureC: 20,
        }),
      );
      answers.push(
        await client.submitReading(alice, registered.stationId, {
          temperatureC: 99,
        }),
      );
      answers.push(
        await client.claim(alice, "mws-00000001", {
          stationKey: "legacy-station-key",
        }),
      );
      const errors: string[] = [];
      for (const bad of [
        () =>
          client.status(alice, registered.stationId, {
            stationKey: "legacy-station-key",
          }),
        () =>
          client.claim(bob, registered.stationId, {
            stationKey: "legacy-station-key",
          }),
        () => client.list({ ...alice, accessToken: "bogus" }),
      ])
        errors.push((await fail(bad())).message);
      const rotated = await client.rotateKey(alice, registered.stationId);

      const tokens = stationRequests().map(
        (r) => r.authorization?.slice(7) ?? "",
      );
      const secrets = [
        registered.ingestKey,
        rotated.ingestKey,
        "legacy-station-key",
        api.clientSecret,
        "authkit.alice",
        ...tokens,
      ];
      const everythingElse = JSON.stringify([answers, errors]) + out.join("\n");
      for (const secret of secrets) {
        expect(secret.length).toBeGreaterThan(8);
        expect(everythingElse, secret.slice(0, 6)).not.toContain(secret);
      }
      expect(out.join("\n")).toBe("");
    });

    it("do not reach the browser even if the API sent them where it should not", async () => {
      const leaky: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/token"))
          return Response.json({
            access_token: "tok",
            expires_in: 900,
            scope: "stations",
          });
        const row = {
          ...EXAMPLE_STATION,
          ingestKey: "LEAKED-KEY",
          keyDigest: "LEAKED-DIGEST",
          ownerEntityId: "LEAKED-OWNER",
          ingest: EXAMPLE_REGISTERED.ingest,
        };
        if (url.endsWith("/v1/stations"))
          return Response.json({ stations: [row], count: 1 });
        return Response.json({
          ...row,
          latestMetrics: { airTemperatureCelsius: 20, note: "LEAKED-NOTE" },
        });
      };
      const client = make({ fetchImpl: leaky });
      const list = await client.list(alice);
      const status = await client.status(alice, "mws-0a1b2c3d");
      expect(JSON.stringify([list, status])).not.toContain("LEAKED");
      expect(Object.keys(list[0] ?? {}).sort()).toEqual([
        "lastObservationAt",
        "name",
        "stationId",
        "stationType",
        "status",
      ]);
      expect(Object.keys(status).sort()).toEqual([
        "lastObservationAt",
        "latestMetrics",
        "name",
        "stationId",
        "stationType",
        "status",
      ]);
    });
  });
});

describe("what the API sends is read defensively", () => {
  /** A fetch that answers the exchange, then whatever the test says. */
  const upstream =
    (answer: (url: string) => Response | Promise<Response>): typeof fetch =>
    async (input) => {
      const url = String(input);
      return url.endsWith("/v1/auth/token")
        ? Response.json({
            access_token: "tok",
            expires_in: 900,
            scope: "stations",
          })
        : answer(url);
    };

  it("reads the contract's own examples", async () => {
    const client = make({
      fetchImpl: upstream((url) => {
        if (url.endsWith("/rotate-key")) return Response.json(EXAMPLE_ROTATED);
        if (url.endsWith("/readings"))
          return Response.json(EXAMPLE_READINGS_OUT);
        if (url.endsWith("/v1/stations"))
          return Response.json({ stations: [EXAMPLE_STATION], count: 1 });
        return Response.json({
          ...EXAMPLE_STATION,
          latestMetrics: { airTemperatureCelsius: 21.4 },
        });
      }),
    });
    expect(await client.list(alice)).toEqual([
      {
        stationId: "mws-0a1b2c3d",
        name: "Chinhoyi School",
        stationType: "digital",
        status: "active",
        lastObservationAt: "2026-11-13T09:04:30.000Z",
      },
    ]);
    expect((await client.status(alice, "mws-0a1b2c3d")).latestMetrics).toEqual({
      airTemperatureCelsius: 21.4,
    });
    expect(
      await client.submitReading(alice, "mws-0a1b2c3d", { temperatureC: 21 }),
    ).toEqual({
      accepted: 1,
      rejected: 1,
      qcStatus: "validated",
      problems: [{ field: "temperatureC", code: "out_of_range" }],
    });
    expect(await client.rotateKey(alice, "mws-0a1b2c3d")).toEqual({
      stationId: "mws-0a1b2c3d",
      ingestKey: "<shown once>",
    });
  });

  it("reads the registration example, taking the upload target from it", async () => {
    const client = make({
      fetchImpl: upstream(() =>
        Response.json(EXAMPLE_REGISTERED, { status: 201 }),
      ),
    });
    const r = await client.register(alice, place);
    expect(r).toMatchObject({
      stationId: "mws-0a1b2c3d",
      ingestKey: "<shown once, 32 characters>",
      stationType: "digital",
    });
    expect(r.ingest?.wunderground).toEqual({
      server: "weather-ingest.nyuchi.com",
      path: "/stations/ingest",
    });
  });

  it("drops an upload target that is not a host and a path, so the console's own is shown", async () => {
    for (const ingest of [
      {
        wunderground: { server: "evil.test/<script>", path: "/x" },
        ecowitt: EXAMPLE_REGISTERED.ingest.ecowitt,
      },
      {
        wunderground: EXAMPLE_REGISTERED.ingest.wunderground,
        ecowitt: { server: "ok.test", path: "/x?y=1" },
      },
      { wunderground: EXAMPLE_REGISTERED.ingest.wunderground },
      "weather-ingest.nyuchi.com",
      null,
    ]) {
      const client = make({
        fetchImpl: upstream(() =>
          Response.json({ ...EXAMPLE_REGISTERED, ingest }, { status: 201 }),
        ),
      });
      expect((await client.register(alice, place)).ingest).toBeUndefined();
    }
  });

  it.each([
    [
      "a station id that is not an id",
      { ...EXAMPLE_REGISTERED, stationId: "../etc" },
    ],
    ["no key", { ...EXAMPLE_REGISTERED, ingestKey: "" }],
    ["a key that is not text", { ...EXAMPLE_REGISTERED, ingestKey: 7 }],
    ["nothing", null],
  ])("refuses a registration answer with %s", async (_what, body) => {
    const client = make({
      fetchImpl: upstream(() => Response.json(body, { status: 201 })),
    });
    expect((await fail(client.register(alice, place))).status).toBe(502);
  });

  it.each([
    ["not a list", { stations: "x" }],
    ["no list", {}],
    ["a bare array", []],
    ["a station that is not an object", { stations: ["x"] }],
    [
      "a station with a bad id",
      { stations: [{ ...EXAMPLE_STATION, stationId: "nope" }] },
    ],
  ])("refuses a list that is %s", async (_what, body) => {
    const client = make({ fetchImpl: upstream(() => Response.json(body)) });
    expect((await fail(client.list(alice))).status).toBe(502);
  });

  it("refuses a readings answer without a count, and keeps only safe problem codes and known fields", async () => {
    const none = make({ fetchImpl: upstream(() => Response.json({})) });
    expect(
      (await fail(none.submitReading(alice, "mws-0a1b2c3d", { windKph: 1 })))
        .status,
    ).toBe(502);
    const odd = make({
      fetchImpl: upstream(() =>
        Response.json({
          accepted: 0,
          rejected: 1,
          errors: [
            {
              index: 0,
              code: "out_of_range",
              field: "windSpeedMs",
              detail: "value was 99 at db-host",
            },
            { index: 0, code: "Not A Code!", field: "somethingElse" },
            "junk",
          ],
        }),
      ),
    });
    const r = await odd.submitReading(alice, "mws-0a1b2c3d", { windKph: 1 });
    expect(r.problems).toEqual([
      { field: "windKph", code: "out_of_range" },
      { field: null, code: "rejected" },
    ]);
    expect(JSON.stringify(r)).not.toContain("db-host");
  });

  it("turns anything else into fixed text, never the API's own words", async () => {
    const hostile = {
      detail: "mongodb://user:pw@db-host/prod failed for key LEAK-123",
      code: "something_new",
      errors: [{ detail: "LEAK-123" }],
    };
    for (const status of [
      400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503,
    ]) {
      const client = make({
        fetchImpl: upstream(() => Response.json(hostile, { status })),
      });
      const e = await fail(client.status(alice, "mws-0a1b2c3d"));
      expect(e.message, String(status)).not.toMatch(/mongodb|LEAK|db-host|pw@/);
      // A refusal from the platform is never "you are signed out".
      expect(e.status, String(status)).not.toBe(401);
    }
  });

  it("does not follow a redirect, and reads an HTML or empty answer as a failure", async () => {
    for (const reply of [
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/" },
        }),
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => new Response(null, { status: 204 }),
      () => new Response("<html>ok</html>", { status: 200 }),
    ]) {
      const client = make({ fetchImpl: upstream(reply) });
      expect((await fail(client.list(alice))).status).toBe(502);
    }
  });

  it("treats a missing collection route as the service being unavailable, not as a missing station", async () => {
    const client = make({
      fetchImpl: upstream(() => new Response("Not Found", { status: 404 })),
    });
    expect(await fail(client.list(alice))).toMatchObject({
      status: 503,
      message: UNAVAILABLE_MESSAGE,
    });
    expect((await fail(client.register(alice, place))).status).toBe(503);
    expect((await fail(client.status(alice, "mws-0a1b2c3d"))).status).toBe(404);
  });

  it("hides network detail and turns a timeout or a dropped connection into a 502", async () => {
    for (const err of [
      new Error("connect ECONNREFUSED 10.0.0.1:443"),
      new DOMException("timed out", "TimeoutError"),
    ]) {
      const client = make({
        fetchImpl: async () => {
          throw err;
        },
      });
      const e = await fail(client.list(alice));
      expect(e.status).toBe(502);
      expect(e.message).not.toMatch(/10\.0\.0\.1|ECONNREFUSED|timed out/);
    }
  });

  it("passes a rate limit on the exchange through as 429", async () => {
    const client = make({
      fetchImpl: async () =>
        Response.json(
          { detail: { error: "slow_down", error_description: "x" } },
          { status: 429 },
        ),
    });
    expect(await fail(client.list(alice))).toMatchObject({ status: 429 });
  });
});
