import {
  type Caller,
  type IssuedCredentials,
  type KeyAuth,
  type ReadingInput,
  type ReadingResult,
  type RegisterInput,
  type StationStatus,
  StationsApiError,
  type StationsClient,
  type StationSummary,
  type StationType,
} from "./types";

type Fetch = typeof fetch;

/**
 * What the Nyuchi API serves today, per the StationKit contract draft
 * (github.com/nyuchi/stationkit issue 5). Everything else this client calls is
 * a PROPOSAL (the Nyuchi weather repo's migration plan, issue 293, section 5.3) that is NOT
 * built: against the live API those calls answer 404 or 5xx, which this
 * client maps to errors the console shows. Do not enable the backend in
 * production for stations until the owners ship these.
 */
export const API_CONTRACT = {
  built: [] as string[],
  /** Drafted in StationKit issue 5; "TODO: confirm" there, so not yet verified. */
  drafted: ["POST /v1/stations/{stationId}/readings"],
  unbuilt: [
    "POST /v1/stations",
    "GET /v1/stations",
    "GET /v1/stations/{stationId}",
    "POST /v1/stations/{stationId}/rotate-key",
  ],
} as const;

export const REQUEST_TIMEOUT_MS = 8000;

export const NOT_LIVE_MESSAGE = "Station registration is not live yet";

export interface NyuchiClientOptions {
  /**
   * Call the endpoints in API_CONTRACT.unbuilt. Off by default: they do not
   * exist on the live API, so the client answers 503 without a network call.
   * Turn on (and move them to `drafted`/`built`) when the API ships them.
   */
  proposedEndpoints?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string")
    throw new StationsApiError(502, `The station service sent no ${field}`);
  return v;
}

function type(v: unknown): StationType {
  return v === "manual" ? "manual" : "digital";
}

function summary(v: unknown): StationSummary {
  if (!isRecord(v))
    throw new StationsApiError(
      502,
      "The station service sent an unreadable station",
    );
  return {
    stationId: str(v.stationId, "stationId"),
    name: typeof v.name === "string" ? v.name : "",
    stationType: type(v.stationType),
    status: typeof v.status === "string" ? v.status : "unknown",
    lastObservationAt:
      typeof v.lastObservationAt === "string" ? v.lastObservationAt : null,
  };
}

function metrics(v: unknown): Record<string, number> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === "number") out[k] = n;
  return Object.keys(out).length ? out : null;
}

/**
 * Upstream statuses become the BFF's own, with fixed text. Upstream detail
 * is never forwarded, and upstream 401/403 become 502 so the browser never
 * mistakes "the platform rejected this session" for "you are signed out".
 */
export function mapUpstreamStatus(status: number): StationsApiError {
  if (status === 404) return new StationsApiError(404, "Station not found");
  if (status === 429)
    return new StationsApiError(429, "Too many requests. Try again later.");
  if (status === 400 || status === 413 || status === 422)
    return new StationsApiError(
      400,
      "The station service rejected that request.",
    );
  return new StationsApiError(
    502,
    "The station service could not complete that request.",
  );
}

/** Console reading fields to the contract's field names (StationKit issue 5). */
export function toContractReading(
  reading: ReadingInput,
  observedAt: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { observedAt };
  if (reading.temperatureC !== undefined)
    out.temperatureC = reading.temperatureC;
  if (reading.humidityPercent !== undefined)
    out.humidityPct = reading.humidityPercent;
  if (reading.pressureHpa !== undefined) out.pressureHpa = reading.pressureHpa;
  if (reading.rainfallMm !== undefined) out.rainfallMm = reading.rainfallMm;
  // The contract takes m/s; the console collects km/h.
  if (reading.windKph !== undefined)
    out.windSpeedMs = Math.round((reading.windKph / 3.6) * 100) / 100;
  return out;
}

/**
 * StationsClient for the Nyuchi API (api.nyuchi.com), the only host this app
 * talks to. Readings follow the StationKit contract draft: `POST
 * /v1/stations/{id}/readings` with `Authorization: Bearer <station key>`.
 * Without a station key the caller's WorkOS access token is sent instead.
 * Neither credential is logged or returned to the browser.
 */
export class NyuchiStationsClient implements StationsClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: Fetch = (...a) => fetch(...a),
    private readonly now: () => Date = () => new Date(),
    private readonly options: NyuchiClientOptions = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  /** Throws 503 for an endpoint that is not live, before any network call. */
  private requireLive(): void {
    if (!this.options.proposedEndpoints)
      throw new StationsApiError(503, NOT_LIVE_MESSAGE);
  }

  private async call(
    bearer: string | undefined,
    path: string,
    init: { method?: string; body?: unknown; missingIs503?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? null : JSON.stringify(init.body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new StationsApiError(502, "The station service is unreachable");
    }
    // A 404 on a collection endpoint means the route is missing, not that a
    // station is: report the service as unavailable.
    if (res.status === 404 && init.missingIs503)
      throw new StationsApiError(503, "The station service is unavailable");
    if (res.status < 200 || res.status > 299)
      throw mapUpstreamStatus(res.status);
    return res.json().catch(() => null);
  }

  async register(caller: Caller, input: RegisterInput) {
    this.requireLive();
    const p = await this.call(caller.accessToken, "/v1/stations", {
      method: "POST",
      body: input,
      missingIs503: true,
    });
    if (!isRecord(p))
      throw new StationsApiError(
        502,
        "The station service sent an unreadable answer",
      );
    return {
      stationId: str(p.stationId, "stationId"),
      ingestKey: str(p.ingestKey, "ingestKey"),
      stationType: type(p.stationType ?? input.stationType),
    };
  }

  async list(caller: Caller): Promise<StationSummary[]> {
    this.requireLive();
    const p = await this.call(caller.accessToken, "/v1/stations", {
      missingIs503: true,
    });
    const items =
      isRecord(p) && Array.isArray(p.stations)
        ? p.stations
        : Array.isArray(p)
          ? p
          : null;
    if (!items)
      throw new StationsApiError(
        502,
        "The station service sent an unreadable list",
      );
    return items.map(summary);
  }

  async status(
    caller: Caller,
    stationId: string,
    auth?: KeyAuth,
  ): Promise<StationStatus> {
    this.requireLive();
    const p = await this.call(
      auth?.stationKey ?? caller.accessToken,
      `/v1/stations/${encodeURIComponent(stationId)}`,
    );
    return {
      ...summary(p),
      latestMetrics: isRecord(p) ? metrics(p.latestMetrics) : null,
    };
  }

  async submitReading(
    caller: Caller,
    stationId: string,
    reading: ReadingInput,
    auth?: KeyAuth,
  ): Promise<ReadingResult> {
    const p = await this.call(
      auth?.stationKey ?? caller.accessToken,
      `/v1/stations/${encodeURIComponent(stationId)}/readings`,
      {
        method: "POST",
        body: {
          stationType: "generic",
          readings: [toContractReading(reading, this.now().toISOString())],
        },
      },
    );
    if (!isRecord(p))
      throw new StationsApiError(
        502,
        "The station service sent an unreadable answer",
      );
    const accepted = typeof p.accepted === "number" ? p.accepted : 0;
    return { accepted, qcStatus: accepted > 0 ? "validated" : "rejected" };
  }

  async rotateKey(
    caller: Caller,
    stationId: string,
  ): Promise<IssuedCredentials> {
    this.requireLive();
    const p = await this.call(
      caller.accessToken,
      `/v1/stations/${encodeURIComponent(stationId)}/rotate-key`,
      {
        method: "POST",
      },
    );
    if (!isRecord(p))
      throw new StationsApiError(
        502,
        "The station service sent an unreadable answer",
      );
    return { stationId, ingestKey: str(p.ingestKey, "ingestKey") };
  }
}
