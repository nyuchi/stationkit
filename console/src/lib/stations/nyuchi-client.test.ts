import { describe, expect, it, vi } from "vitest";
import {
  API_CONTRACT,
  NOT_LIVE_MESSAGE,
  mapUpstreamStatus,
  NyuchiStationsClient,
  REQUEST_TIMEOUT_MS,
  toContractReading,
} from "./nyuchi-client";
import { type Caller, StationsApiError } from "./types";

const caller: Caller = {
  personId: "p1",
  email: "a@example.test",
  accessToken: "tok-123",
};
const NOW = new Date("2026-10-11T08:00:00Z");

function client(reply: { status?: number; body?: unknown } | Error) {
  const fetchMock = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
    });
  });
  return {
    fetchMock,
    api: new NyuchiStationsClient(
      "https://api.example.test/",
      fetchMock as unknown as typeof fetch,
      () => NOW,
      { proposedEndpoints: true },
    ),
    // The shipped default: proposed endpoints stay off.
    shipped: new NyuchiStationsClient(
      "https://api.example.test/",
      fetchMock as unknown as typeof fetch,
      () => NOW,
    ),
  };
}

const lastCall = (m: ReturnType<typeof vi.fn>) => {
  const [url, init] = m.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
};

describe("readings follow the StationKit contract draft", () => {
  it("POSTs /v1/stations/{id}/readings with the station key as Bearer and contract field names", async () => {
    const { api, fetchMock } = client({
      body: { accepted: 2, rejected: 0, errors: [] },
    });
    const r = await api.submitReading(
      caller,
      "mws-0a0a0a0a",
      { temperatureC: 21.5, humidityPercent: 60, windKph: 36 },
      { stationKey: "station-secret" },
    );
    expect(r).toEqual({ accepted: 2, qcStatus: "validated" });
    const { url, init, headers } = lastCall(fetchMock);
    expect(url).toBe(
      "https://api.example.test/v1/stations/mws-0a0a0a0a/readings",
    );
    expect(init.method).toBe("POST");
    expect(headers.Authorization).toBe("Bearer station-secret");
    expect(JSON.parse(init.body as string)).toEqual({
      stationType: "generic",
      readings: [
        {
          observedAt: "2026-10-11T08:00:00.000Z",
          temperatureC: 21.5,
          humidityPct: 60,
          windSpeedMs: 10,
        },
      ],
    });
  });

  it("falls back to the person's token when there is no station key", async () => {
    const { api, fetchMock } = client({ body: { accepted: 1 } });
    await api.submitReading(caller, "mws-0a0a0a0a", { rainfallMm: 2 });
    expect(lastCall(fetchMock).headers.Authorization).toBe("Bearer tok-123");
  });

  it("reports zero accepted readings as rejected by quality control", async () => {
    const { api } = client({
      body: { accepted: 0, rejected: 1, errors: ["out of range"] },
    });
    expect(
      await api.submitReading(caller, "mws-0a0a0a0a", { temperatureC: 20 }),
    ).toEqual({
      accepted: 0,
      qcStatus: "rejected",
    });
  });

  it("converts units and omits fields that were not measured", () => {
    expect(
      toContractReading(
        { windKph: 18, pressureHpa: 1013.2, rainfallMm: 0 },
        "t",
      ),
    ).toEqual({
      observedAt: "t",
      windSpeedMs: 5,
      pressureHpa: 1013.2,
      rainfallMm: 0,
    });
  });
});

describe("unbuilt endpoints are not called", () => {
  const caller2: Caller = {
    personId: "p1",
    email: "a@example.test",
    accessToken: "tok",
  };

  it("answers 503 with no network call for register, list, status and rotate", async () => {
    const { shipped, fetchMock } = client({ body: {} });
    const calls = [
      () =>
        shipped.register(caller2, {
          name: "Farm",
          lat: 1,
          lon: 2,
          stationType: "manual",
        }),
      () => shipped.list(caller2),
      () => shipped.status(caller2, "mws-0a0a0a0a", { stationKey: "k" }),
      () => shipped.rotateKey(caller2, "mws-0a0a0a0a"),
    ];
    for (const call of calls) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(StationsApiError);
      expect((e as StationsApiError).status).toBe(503);
      expect((e as StationsApiError).message).toBe(NOT_LIVE_MESSAGE);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends readings, the drafted call", async () => {
    const { shipped, fetchMock } = client({ body: { accepted: 1 } });
    await shipped.submitReading(caller2, "mws-0a0a0a0a", { windKph: 3 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps a 404 on list and register to service unavailable, not station not found", async () => {
    const a = await client({ status: 404 })
      .api.list(caller2)
      .catch((x: unknown) => x);
    expect((a as StationsApiError).status).toBe(503);
    const b = await client({ status: 404 })
      .api.register(caller2, {
        name: "F",
        lat: 0,
        lon: 0,
        stationType: "digital",
      })
      .catch((x: unknown) => x);
    expect((b as StationsApiError).status).toBe(503);
    expect((b as StationsApiError).message).toBe(
      "The station service is unavailable",
    );
    const c = await client({ status: 404 })
      .api.status(caller2, "mws-0a0a0a0a")
      .catch((x: unknown) => x);
    expect((c as StationsApiError).status).toBe(404);
  });
});

describe("the proposed endpoints, when enabled", () => {
  it("lists the proposed endpoints as unbuilt and only the drafted one as drafted", () => {
    expect(API_CONTRACT.built).toEqual([]);
    expect(API_CONTRACT.drafted).toEqual([
      "POST /v1/stations/{stationId}/readings",
    ]);
    expect(API_CONTRACT.unbuilt).toContain("POST /v1/stations");
    expect(API_CONTRACT.unbuilt).toContain("GET /v1/stations");
  });

  it("registers, lists, reads status and rotates against the proposed paths", async () => {
    const a = client({
      status: 201,
      body: {
        stationId: "mws-0a0a0a0a",
        ingestKey: "k",
        stationType: "manual",
      },
    });
    expect(
      await a.api.register(caller, {
        name: "Farm",
        lat: 1,
        lon: 2,
        stationType: "manual",
      }),
    ).toEqual({
      stationId: "mws-0a0a0a0a",
      ingestKey: "k",
      stationType: "manual",
    });
    expect(lastCall(a.fetchMock).url).toBe(
      "https://api.example.test/v1/stations",
    );
    expect(lastCall(a.fetchMock).headers.Authorization).toBe("Bearer tok-123");

    const row = {
      stationId: "mws-0a0a0a0a",
      name: "F",
      stationType: "digital",
      status: "active",
      lastObservationAt: null,
    };
    expect(
      await client({ body: { stations: [row] } }).api.list(caller),
    ).toHaveLength(1);
    expect(await client({ body: [row] }).api.list(caller)).toHaveLength(1);
    await expect(
      client({ body: { nope: 1 } }).api.list(caller),
    ).rejects.toMatchObject({
      status: 502,
    });

    const s = client({
      body: { ...row, latestMetrics: { airTemperatureCelsius: 20, bad: "x" } },
    });
    expect(
      (await s.api.status(caller, "mws-0a0a0a0a", { stationKey: "key-1" }))
        .latestMetrics,
    ).toEqual({ airTemperatureCelsius: 20 });
    expect(lastCall(s.fetchMock).url).not.toContain("key-1");
    expect(lastCall(s.fetchMock).headers.Authorization).toBe("Bearer key-1");

    const r = client({ body: { ingestKey: "new" } });
    expect(await r.api.rotateKey(caller, "mws-0a0a0a0a")).toEqual({
      stationId: "mws-0a0a0a0a",
      ingestKey: "new",
    });
    expect(lastCall(r.fetchMock).url).toMatch(/\/rotate-key$/);
  });

  it("rejects an answer without the one-time key", async () => {
    await expect(
      client({ body: { stationId: "mws-0a0a0a0a" } }).api.register(caller, {
        name: "F",
        lat: 0,
        lon: 0,
        stationType: "digital",
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("requests and errors", () => {
  it("never follows redirects and always has a timeout", async () => {
    const { api, fetchMock } = client({ body: { stations: [] } });
    await api.list(caller);
    const { init } = lastCall(fetchMock);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it.each([
    [404, 404],
    [429, 429],
    [400, 400],
    [422, 400],
    [401, 502],
    [403, 502],
    [500, 502],
    [503, 502],
    [301, 502],
    [302, 502],
    [204, 502],
  ])("maps upstream %i to %i", async (upstream, mapped) => {
    const e = await client({ status: upstream })
      .api.status(caller, "mws-0a0a0a0a")
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StationsApiError);
    expect((e as StationsApiError).status).toBe(mapped);
    expect(mapUpstreamStatus(upstream).status).toBe(mapped);
  });

  it("never passes upstream detail or network details to the browser", async () => {
    const a = await client({
      status: 404,
      body: { detail: "mongo exploded at host-x" },
    })
      .api.status(caller, "mws-0a0a0a0a")
      .catch((x: unknown) => x);
    expect((a as StationsApiError).message).toBe("Station not found");
    const b = await client(new Error("connect ECONNREFUSED 10.0.0.1"))
      .api.list(caller)
      .catch((x: unknown) => x);
    expect((b as StationsApiError).status).toBe(502);
    expect((b as StationsApiError).message).not.toContain("10.0.0.1");
  });

  it("turns a timeout into a 502", async () => {
    const e = await client(new DOMException("timed out", "TimeoutError"))
      .api.list(caller)
      .catch((x: unknown) => x);
    expect((e as StationsApiError).status).toBe(502);
  });
});
