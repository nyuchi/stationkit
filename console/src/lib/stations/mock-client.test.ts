import { beforeEach, describe, expect, it } from "vitest";
import {
  MOCK_LEGACY_STATION,
  MOCK_STATION_CAP,
  MockStationsClient,
} from "./mock-client";
import { type Caller, StationsApiError } from "./types";

const alice: Caller = { personId: "p-alice", email: "alice@example.test" };
const bob: Caller = { personId: "p-bob", email: "bob@example.test" };
const input = {
  name: "Alice farm",
  lat: -17.8,
  lon: 31.05,
  stationType: "manual",
  country: "ZW",
} as const;

let client: MockStationsClient;
beforeEach(() => {
  client = new MockStationsClient({
    now: () => new Date("2026-10-11T08:00:00Z"),
    seedDemo: true,
  });
});

const status = (e: unknown) =>
  e instanceof StationsApiError ? e.status : null;

describe("MockStationsClient", () => {
  it("registers with a backend-shaped id and a fresh key each time", async () => {
    const a = await client.register(alice, input);
    const b = await client.register(alice, input);
    expect(a.stationId).toMatch(/^mws-[a-f0-9]{8}$/);
    expect(a.ingestKey.length).toBeGreaterThanOrEqual(30);
    expect(a.ingestKey).not.toBe(b.ingestKey);
    expect(a.stationType).toBe("manual");
  });

  it("lists only the caller's stations and never exposes a key", async () => {
    await client.register(alice, input);
    expect(await client.list(bob)).toEqual([]);
    const mine = await client.list(alice);
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toMatch(/key/i);
  });

  it("hides other owners' stations as not found", async () => {
    const { stationId } = await client.register(alice, input);
    await expect(client.status(bob, stationId)).rejects.toSatisfy(
      (e) => status(e) === 404,
    );
    await expect(
      client.submitReading(bob, stationId, { temperatureC: 20 }),
    ).rejects.toSatisfy((e) => status(e) === 404);
    await expect(client.status(bob, "mws-ffffffff")).rejects.toSatisfy(
      (e) => status(e) === 404,
    );
  });

  it("accepts a station key from a non-owner, and rejects a wrong one", async () => {
    const { stationId, ingestKey } = await client.register(alice, input);
    expect(
      (await client.status(bob, stationId, { stationKey: ingestKey }))
        .stationId,
    ).toBe(stationId);
    // A wrong key and a missing station are the same answer, as at the API.
    await expect(
      client.status(bob, stationId, { stationKey: "nope" }),
    ).rejects.toSatisfy((e) => status(e) === 403);
    await expect(
      client.status(bob, "mws-ffffffff", { stationKey: "nope" }),
    ).rejects.toSatisfy((e) => status(e) === 403);
  });

  it("serves the seeded legacy station by key only", async () => {
    const s = MOCK_LEGACY_STATION;
    expect(await client.list(alice)).toEqual([]);
    expect(
      (await client.status(alice, s.stationId, { stationKey: s.key })).name,
    ).toBe(s.name);
    await expect(client.status(alice, s.stationId)).rejects.toSatisfy(
      (e) => status(e) === 404,
    );
  });

  it("validates a reading, records backend metric names and the time", async () => {
    const { stationId } = await client.register(alice, input);
    const res = await client.submitReading(alice, stationId, {
      temperatureC: 21.5,
      rainfallMm: 2,
    });
    expect(res).toEqual({
      accepted: 1,
      rejected: 0,
      qcStatus: "validated",
      problems: [],
    });
    const st = await client.status(alice, stationId);
    expect(st.lastObservationAt).toBe("2026-10-11T08:00:00.000Z");
    expect(st.latestMetrics).toEqual({
      airTemperatureCelsius: 21.5,
      precipitationMillimeters: 2,
    });
  });

  it("rejects readings that fail quality control and leaves status untouched", async () => {
    const { stationId } = await client.register(alice, input);
    expect(
      await client.submitReading(alice, stationId, { temperatureC: 99 }),
    ).toEqual({
      accepted: 0,
      rejected: 1,
      qcStatus: "rejected",
      problems: [{ field: "temperatureC", code: "out_of_range" }],
    });
    expect(
      (await client.status(alice, stationId)).lastObservationAt,
    ).toBeNull();
  });

  it("refuses a whole reading when one value is out of range, as the API does for a typed reading", async () => {
    const { stationId } = await client.register(alice, input);
    const res = await client.submitReading(alice, stationId, {
      temperatureC: 21,
      humidityPercent: 150,
    });
    expect(res.qcStatus).toBe("rejected");
    expect(res.problems).toEqual([
      { field: "humidityPercent", code: "out_of_range" },
    ]);
    expect((await client.status(alice, stationId)).latestMetrics).toBeNull();
    expect((await client.submitReading(alice, stationId, {})).problems).toEqual(
      [{ field: null, code: "no_measurement" }],
    );
  });

  it("rotates the key: new key works, old key stops, a key cannot rotate itself", async () => {
    const { stationId, ingestKey } = await client.register(alice, input);
    await expect(client.rotateKey(bob, stationId)).rejects.toSatisfy(
      (e) => status(e) === 404,
    );
    const rotated = await client.rotateKey(alice, stationId);
    expect(rotated.ingestKey).not.toBe(ingestKey);
    await expect(
      client.status(bob, stationId, { stationKey: ingestKey }),
    ).rejects.toSatisfy((e) => status(e) === 403);
    expect(
      (await client.status(bob, stationId, { stationKey: rotated.ingestKey }))
        .stationId,
    ).toBe(stationId);
    await expect(client.rotateKey(bob, stationId)).rejects.toBeInstanceOf(
      StationsApiError,
    );
  });

  it("has no demo station unless asked, and is bounded", async () => {
    const bare = new MockStationsClient();
    await expect(
      bare.status(alice, MOCK_LEGACY_STATION.stationId, {
        stationKey: MOCK_LEGACY_STATION.key,
      }),
    ).rejects.toSatisfy((e) => status(e) === 403);
    for (let i = 0; i < MOCK_STATION_CAP; i++)
      await bare.register(alice, input);
    await expect(bare.register(alice, input)).rejects.toSatisfy(
      (e) => status(e) === 429,
    );
  });

  it("lets a person claim a legacy station with its key, and then it is theirs", async () => {
    const s = MOCK_LEGACY_STATION;
    await expect(
      client.claim(alice, s.stationId, { stationKey: "wrong" }),
    ).rejects.toSatisfy((e) => status(e) === 403);
    await expect(client.claim(alice, s.stationId, {})).rejects.toSatisfy(
      (e) => status(e) === 403,
    );
    const claimed = await client.claim(alice, s.stationId, {
      stationKey: s.key,
    });
    expect(claimed.stationId).toBe(s.stationId);
    expect((await client.list(alice)).map((x) => x.stationId)).toEqual([
      s.stationId,
    ]);
    expect((await client.status(alice, s.stationId)).name).toBe(s.name);
    // Claiming your own again changes nothing; anyone else's is a 404.
    expect(
      (await client.claim(alice, s.stationId, { stationKey: s.key })).stationId,
    ).toBe(s.stationId);
    await expect(
      client.claim(bob, s.stationId, { stationKey: s.key }),
    ).rejects.toSatisfy((e) => status(e) === 404);
    await expect(
      client.claim(bob, "mws-ffffffff", { stationKey: s.key }),
    ).rejects.toSatisfy((e) => status(e) === 404);
    // A claimed station can be rotated by its owner, which a key alone cannot.
    expect((await client.rotateKey(alice, s.stationId)).ingestKey).toBeTruthy();
  });
});
