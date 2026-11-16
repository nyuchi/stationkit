import {
  type Caller,
  type IssuedCredentials,
  type KeyAuth,
  type ReadingField,
  type ReadingInput,
  type ReadingProblem,
  type ReadingResult,
  type RegisterInput,
  type StationStatus,
  StationsApiError,
  type StationsClient,
  type StationSummary,
  type StationType,
} from "./types";

interface MockStation {
  stationId: string;
  name: string;
  stationType: StationType;
  ownerId: string | null;
  keyHash: string;
  status: string;
  lastObservationAt: string | null;
  latestMetrics: Record<string, number> | null;
}

/** Backend metric names for the console's reading fields. */
const METRIC_NAMES = {
  temperatureC: "airTemperatureCelsius",
  humidityPercent: "relativeHumidityPercent",
  pressureHpa: "atmosphericPressureMillibar",
  windKph: "windSpeedKph",
  rainfallMm: "precipitationMillimeters",
} as const;

/** Inline QC ranges of the backend (`QC_RANGES`), keyed by metric name. */
const QC_RANGES: Record<string, readonly [number, number]> = {
  airTemperatureCelsius: [-50, 60],
  relativeHumidityPercent: [0, 100],
  atmosphericPressureMillibar: [800, 1100],
  windSpeedKph: [0, 250],
  precipitationMillimeters: [0, 500],
};

/** Upper bound on in-memory stations, so the mock cannot grow without limit. */
export const MOCK_STATION_CAP = 200;

/** Demo station for exercising the key-only (legacy) path against the mock. */
export const MOCK_LEGACY_STATION = {
  stationId: "mws-00000001",
  key: "legacy-demo-key",
  name: "Demo school (legacy key)",
} as const;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return toHex(new Uint8Array(digest));
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomStationId(): string {
  return `mws-${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;
}

/**
 * In-memory StationsClient with the same behaviour the real API is specified
 * to have: owner-scoped lists, a key shown once, optional station-key access,
 * and the backend's quality-control ranges. State lives per instance.
 */
export class MockStationsClient implements StationsClient {
  private readonly stations = new Map<string, MockStation>();
  private seeded: Promise<void>;

  /**
   * `seedDemo` adds the public demo station (MOCK_LEGACY_STATION). It is for
   * `astro dev` and tests only; the production runtime refuses this backend.
   */
  constructor(options: { now?: () => Date; seedDemo?: boolean } = {}) {
    this.now = options.now ?? (() => new Date());
    this.seeded = options.seedDemo ? this.seed() : Promise.resolve();
  }

  private readonly now: () => Date;

  private async seed(): Promise<void> {
    this.stations.set(MOCK_LEGACY_STATION.stationId, {
      stationId: MOCK_LEGACY_STATION.stationId,
      name: MOCK_LEGACY_STATION.name,
      stationType: "manual",
      ownerId: null,
      keyHash: await sha256(MOCK_LEGACY_STATION.key),
      status: "active",
      lastObservationAt: null,
      latestMetrics: null,
    });
  }

  private async authorise(
    caller: Caller,
    stationId: string,
    auth?: KeyAuth,
  ): Promise<MockStation> {
    await this.seeded;
    const station = this.stations.get(stationId);
    // A key was sent: it opens this station or it does not. The API answers a
    // wrong key and a missing station alike, so the mock does too.
    if (auth?.stationKey) {
      if (station && (await sha256(auth.stationKey)) === station.keyHash)
        return station;
      throw new StationsApiError(403, "That station key was not accepted.");
    }
    if (
      station &&
      station.ownerId !== null &&
      station.ownerId === caller.personId
    )
      return station;
    // Never reveal whether the id exists to someone who cannot use it.
    throw new StationsApiError(404, "Station not found");
  }

  async register(
    caller: Caller,
    input: RegisterInput,
  ): Promise<IssuedCredentials & { stationType: StationType }> {
    await this.seeded;
    if (this.stations.size >= MOCK_STATION_CAP)
      throw new StationsApiError(
        429,
        "The demo backend is full. Restart the dev server.",
      );
    const stationId = randomStationId();
    const ingestKey = randomKey();
    this.stations.set(stationId, {
      stationId,
      name: input.name,
      stationType: input.stationType,
      ownerId: caller.personId,
      keyHash: await sha256(ingestKey),
      status: "active",
      lastObservationAt: null,
      latestMetrics: null,
    });
    return { stationId, ingestKey, stationType: input.stationType };
  }

  async list(caller: Caller): Promise<StationSummary[]> {
    await this.seeded;
    return [...this.stations.values()]
      .filter((s) => s.ownerId === caller.personId)
      .map(({ stationId, name, stationType, status, lastObservationAt }) => ({
        stationId,
        name,
        stationType,
        status,
        lastObservationAt,
      }));
  }

  async status(
    caller: Caller,
    stationId: string,
    auth?: KeyAuth,
  ): Promise<StationStatus> {
    const s = await this.authorise(caller, stationId, auth);
    return {
      stationId: s.stationId,
      name: s.name,
      stationType: s.stationType,
      status: s.status,
      lastObservationAt: s.lastObservationAt,
      latestMetrics: s.latestMetrics,
    };
  }

  async submitReading(
    caller: Caller,
    stationId: string,
    reading: ReadingInput,
    auth?: KeyAuth,
  ): Promise<ReadingResult> {
    const s = await this.authorise(caller, stationId, auth);
    const metrics: Record<string, number> = {};
    const problems: ReadingProblem[] = [];
    for (const [field, value] of Object.entries(reading) as [
      ReadingField,
      unknown,
    ][]) {
      const name = METRIC_NAMES[field];
      const range = name ? QC_RANGES[name] : undefined;
      if (!name || !range || typeof value !== "number") continue;
      if (value >= range[0] && value <= range[1]) metrics[name] = value;
      else problems.push({ field, code: "out_of_range" });
    }
    // As the API does for a reading a person typed: one value out of range
    // refuses the whole reading, and so does a reading with nothing in it.
    if (problems.length === 0 && Object.keys(metrics).length === 0)
      problems.push({ field: null, code: "no_measurement" });
    if (problems.length > 0)
      return { accepted: 0, rejected: 1, qcStatus: "rejected", problems };
    s.lastObservationAt = this.now().toISOString();
    s.latestMetrics = metrics;
    return { accepted: 1, rejected: 0, qcStatus: "validated", problems: [] };
  }

  async rotateKey(
    caller: Caller,
    stationId: string,
  ): Promise<IssuedCredentials> {
    // Rotation is an owner action: a station key alone cannot rotate itself.
    const s = await this.authorise(caller, stationId);
    const ingestKey = randomKey();
    s.keyHash = await sha256(ingestKey);
    return { stationId, ingestKey };
  }

  async claim(
    caller: Caller,
    stationId: string,
    auth: KeyAuth,
  ): Promise<StationSummary> {
    await this.seeded;
    const s = this.stations.get(stationId);
    if (!s) throw new StationsApiError(404, "This station cannot be claimed");
    if (s.ownerId === caller.personId) return summaryOf(s);
    // A station somebody owns is a 404, as it is at the API.
    if (s.ownerId !== null)
      throw new StationsApiError(404, "This station cannot be claimed");
    if (!auth.stationKey || (await sha256(auth.stationKey)) !== s.keyHash)
      throw new StationsApiError(403, "That is not this station's key.");
    s.ownerId = caller.personId;
    return summaryOf(s);
  }
}

function summaryOf(s: MockStation): StationSummary {
  return {
    stationId: s.stationId,
    name: s.name,
    stationType: s.stationType,
    status: s.status,
    lastObservationAt: s.lastObservationAt,
  };
}
