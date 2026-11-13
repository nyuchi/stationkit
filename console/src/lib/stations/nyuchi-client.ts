import { parseIngestSetup } from "../ingest";
import {
  failureCode,
  isRecord,
  KEY_NOT_ACCEPTED_MESSAGE,
  mapStationFailure,
  NOT_LIVE_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from "./nyuchi-errors";
import {
  type ConsoleCredentials,
  type Send,
  TokenBroker,
  type UpstreamReply,
  type UpstreamRequest,
} from "./nyuchi-token";
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
import { isStationId } from "./validators";

export { NOT_LIVE_MESSAGE };

type Fetch = typeof fetch;

/**
 * Every route this client calls: the whole of the console's data egress. The
 * contract is the Nyuchi API's OpenAPI document (nyuchi/nyuchi-api, built in
 * its pull requests 540, 541 and 542; docs/architecture/stations.md and
 * docs/AUTH.md). A guard test fails if a request goes anywhere else.
 */
export const API_ROUTES = [
  "POST /v1/auth/token",
  "POST /v1/identity/persons/ensure",
  "POST /v1/stations",
  "GET /v1/stations",
  "GET /v1/stations/{stationId}",
  "POST /v1/stations/{stationId}/readings",
  "POST /v1/stations/{stationId}/rotate-key",
  "POST /v1/stations/{stationId}/claim",
] as const;

export const REQUEST_TIMEOUT_MS = 8000;

/** The largest answer read from the API; a list of 50 stations is a few tens of kilobytes. */
const MAX_BODY_CHARS = 512 * 1024;

export interface NyuchiClientOptions {
  /**
   * The console's own internal key. Without it the routes that act for a
   * person answer 503 "not live yet" without a network call, so a deploy that
   * has not been given its key behaves as the console always has; a station's
   * own key still opens its status and readings.
   */
  credentials?: ConsoleCredentials | null | undefined;
  fetchImpl?: Fetch | undefined;
  now?: (() => number) | undefined;
}

/** The API's reading fields, by the console's names. */
const API_READING_FIELD: Record<ReadingField, string> = {
  temperatureC: "temperatureC",
  humidityPercent: "humidityPct",
  pressureHpa: "pressureHpa",
  rainfallMm: "rainfallMm",
  // The console collects km/h and the API accepts it, so nothing is converted
  // to m/s and back (which loses a hundredth).
  windKph: "windSpeedKph",
};

const CONSOLE_READING_FIELD = new Map<string, ReadingField>([
  ...Object.entries(API_READING_FIELD).map(
    ([console_, api]) => [api, console_ as ReadingField] as const,
  ),
  ["windSpeedMs", "windKph"],
]);

/** Console reading fields to the API's field names (nyuchi/stationkit#5, as the API accepts it). */
export function toApiReading(reading: ReadingInput): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [field, value] of Object.entries(reading) as [
    ReadingField,
    number | undefined,
  ][])
    if (value !== undefined && API_READING_FIELD[field])
      out[API_READING_FIELD[field]] = value;
  return out;
}

function unreadable(what: string): StationsApiError {
  return new StationsApiError(502, `The station service sent ${what}`);
}

function type(v: unknown): StationType {
  return v === "manual" ? "manual" : "digital";
}

function stationId(v: unknown): string {
  if (!isStationId(v)) throw unreadable("an unreadable station id");
  return v;
}

function summary(v: unknown): StationSummary {
  if (!isRecord(v)) throw unreadable("an unreadable station");
  return {
    stationId: stationId(v.stationId),
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
  for (const [k, n] of Object.entries(v))
    if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  return Object.keys(out).length ? out : null;
}

const PROBLEM_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Why readings were refused: the field and a code, never anything the API says in prose. */
function problems(v: unknown): ReadingProblem[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 20).flatMap((e: unknown): ReadingProblem[] => {
    if (!isRecord(e)) return [];
    return [
      {
        field:
          typeof e.field === "string"
            ? (CONSOLE_READING_FIELD.get(e.field) ?? null)
            : null,
        code:
          typeof e.code === "string" && PROBLEM_CODE_RE.test(e.code)
            ? e.code
            : "rejected",
      },
    ];
  });
}

interface Call {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** A 404 with no problem code means the route is missing, not a station. */
  missingIs503?: boolean;
}

/**
 * StationsClient for the Nyuchi API (api.nyuchi.com), the only host this app
 * talks to.
 *
 * A signed-in person's calls carry a token exchanged for their AuthKit token
 * (nyuchi-token.ts). A station's own key, when the browser holds one for a
 * legacy station, is sent as the bearer for that station's status and readings
 * and nothing else. Neither credential is logged, put in a URL, or returned.
 * Failures become fixed text (nyuchi-errors.ts); the API's own words never do.
 */
export class NyuchiStationsClient implements StationsClient {
  private readonly base: string;
  private readonly fetchImpl: Fetch;
  private readonly broker: TokenBroker | null;

  constructor(baseUrl: string, options: NyuchiClientOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((...a) => fetch(...a));
    this.broker = options.credentials
      ? new TokenBroker(options.credentials, this.send, options.now)
      : null;
  }

  /** The one place a request leaves the app. */
  private readonly send: Send = async (
    request: UpstreamRequest,
  ): Promise<UpstreamReply> => {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${request.path}`, {
        method: request.method,
        headers: request.headers,
        body: request.body ?? null,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new StationsApiError(502, "The station service is unreachable");
    }
    let body: unknown = null;
    try {
      const text = await res.text();
      if (text.length <= MAX_BODY_CHARS) body = JSON.parse(text);
    } catch {
      // Not JSON, or cut off: the status still says what happened.
    }
    return { status: res.status, body };
  };

  private build(call: Call, bearer: string): UpstreamRequest {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${bearer}`,
    };
    if (call.body !== undefined) headers["Content-Type"] = "application/json";
    return {
      method: call.method,
      path: call.path,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    };
  }

  private succeed(reply: UpstreamReply, call: Call): unknown {
    if (reply.status >= 200 && reply.status <= 299) return reply.body;
    const code = failureCode(reply.body);
    // A collection route that is missing is the service being unavailable.
    if (reply.status === 404 && call.missingIs503 && code === null)
      throw new StationsApiError(503, UNAVAILABLE_MESSAGE);
    throw mapStationFailure(reply.status, code);
  }

  /** Acts for the signed-in person, with a token exchanged for their AuthKit token. */
  private async asPerson(caller: Caller, call: Call): Promise<unknown> {
    if (!this.broker) throw new StationsApiError(503, NOT_LIVE_MESSAGE);
    if (!caller.accessToken)
      throw new StationsApiError(401, "Sign in to use the station console");
    let issued = await this.broker.token(caller.accessToken);
    let reply = await this.send(this.build(call, issued.token));
    // A cached token the API no longer accepts (it was revoked or aged out
    // between our clock and its own): exchange once more, once. The request
    // was refused before it did anything, so sending it again is safe.
    if (reply.status === 401 && issued.cached) {
      await this.broker.forget(caller.accessToken);
      issued = await this.broker.token(caller.accessToken);
      reply = await this.send(this.build(call, issued.token));
    }
    return this.succeed(reply, call);
  }

  /** Acts with a station's own key, which opens that station's status and readings only. */
  private async asKey(key: string, call: Call): Promise<unknown> {
    const reply = await this.send(this.build(call, key));
    if (reply.status === 401)
      throw new StationsApiError(403, KEY_NOT_ACCEPTED_MESSAGE);
    return this.succeed(reply, call);
  }

  private stationPath(id: string, tail = ""): string {
    return `/v1/stations/${encodeURIComponent(id)}${tail}`;
  }

  async register(caller: Caller, input: RegisterInput) {
    const p = await this.asPerson(caller, {
      method: "POST",
      path: "/v1/stations",
      body: {
        name: input.name,
        lat: input.lat,
        lon: input.lon,
        stationType: input.stationType,
        country: input.country,
        ...(input.hardware ? { hardware: input.hardware } : {}),
      },
      missingIs503: true,
    });
    if (!isRecord(p) || typeof p.ingestKey !== "string" || !p.ingestKey)
      throw unreadable("no ingest key");
    // The API says where the station uploads; fall back to the console's own
    // configured host only if it said nothing usable.
    const ingest = parseIngestSetup(p.ingest);
    return {
      stationId: stationId(p.stationId),
      ingestKey: p.ingestKey,
      stationType: type(p.stationType ?? input.stationType),
      ...(ingest ? { ingest } : {}),
    };
  }

  async list(caller: Caller): Promise<StationSummary[]> {
    const p = await this.asPerson(caller, {
      method: "GET",
      path: "/v1/stations",
      missingIs503: true,
    });
    if (!isRecord(p) || !Array.isArray(p.stations))
      throw unreadable("an unreadable list");
    return p.stations.map(summary);
  }

  async status(
    caller: Caller,
    id: string,
    auth?: KeyAuth,
  ): Promise<StationStatus> {
    const call: Call = { method: "GET", path: this.stationPath(id) };
    const p = auth?.stationKey
      ? await this.asKey(auth.stationKey, call)
      : await this.asPerson(caller, call);
    return {
      ...summary(p),
      latestMetrics: isRecord(p) ? metrics(p.latestMetrics) : null,
    };
  }

  async submitReading(
    caller: Caller,
    id: string,
    reading: ReadingInput,
    auth?: KeyAuth,
  ): Promise<ReadingResult> {
    const call: Call = {
      method: "POST",
      path: this.stationPath(id, "/readings"),
      // No observedAt: for a single reading the API stamps the time itself,
      // so a Worker clock that is a few minutes out cannot get it refused.
      body: { stationType: "generic", readings: [toApiReading(reading)] },
    };
    const p = auth?.stationKey
      ? await this.asKey(auth.stationKey, call)
      : await this.asPerson(caller, call);
    if (!isRecord(p) || typeof p.accepted !== "number")
      throw unreadable("an unreadable answer");
    const accepted = p.accepted;
    return {
      accepted,
      rejected: typeof p.rejected === "number" ? p.rejected : 0,
      qcStatus: accepted > 0 ? "validated" : "rejected",
      problems: problems(p.errors),
    };
  }

  async rotateKey(caller: Caller, id: string): Promise<IssuedCredentials> {
    const p = await this.asPerson(caller, {
      method: "POST",
      path: this.stationPath(id, "/rotate-key"),
    });
    if (!isRecord(p) || typeof p.ingestKey !== "string" || !p.ingestKey)
      throw unreadable("no ingest key");
    // `id` was validated by the BFF; the answer's own id is not trusted over it.
    return { stationId: id, ingestKey: p.ingestKey };
  }

  async claim(
    caller: Caller,
    id: string,
    auth: KeyAuth,
  ): Promise<StationSummary> {
    if (!auth.stationKey)
      throw new StationsApiError(400, "Send the station's key to claim it.");
    try {
      return summary(
        await this.asPerson(caller, {
          method: "POST",
          path: this.stationPath(id, "/claim"),
          body: { ingestKey: auth.stationKey },
        }),
      );
    } catch (err) {
      // The API answers 404 for a station that is someone else's, and for one
      // that is not there: say what the person can do about it.
      if (err instanceof StationsApiError && err.status === 404)
        throw new StationsApiError(404, "This station cannot be claimed");
      throw err;
    }
  }
}
