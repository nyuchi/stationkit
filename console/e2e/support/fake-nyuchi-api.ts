/**
 * A fake Nyuchi API for the console's tests: no network to production, no
 * database. It answers the routes the console's BFF calls, in the shapes the
 * real API documents, so the real client (src/lib/stations/nyuchi-client.ts)
 * can be driven end to end.
 *
 * Where the shapes come from. The EXAMPLE_* values below are transcribed from
 * the API's OpenAPI contract: the `json_schema_extra` examples in
 * `gateway/routers/stations.py` and the token exchange in `docs/AUTH.md`
 * (nyuchi/nyuchi-api `staging` at a9bf9f7, after #540, #541 and #542). Every
 * answer is built by cloning an example and changing only what the request
 * decides, and a test checks the answers keep the examples' keys. The fake
 * enforces the same rules the API documents: owner isolation (a foreign
 * station is a 404), a key that opens nothing is a 401, an out-of-range
 * reading is a 200 with `rejected`, errors are RFC 9457 problems, the exchange
 * answers `404 person_not_found` until the person is ensured.
 *
 * It is not the API: it keeps everything in memory, has no clock skew, and
 * does not model every limit. What it does not model is listed in the PR.
 *
 * Standalone and erasable-TypeScript only (no enums, no parameter
 * properties), so Node can run it directly:
 *   node --experimental-strip-types e2e/support/fake-nyuchi-api.ts --port 4410
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

// --- the contract's examples -------------------------------------------------------------

export const EXAMPLE_STATION = {
  stationId: "mws-0a1b2c3d",
  name: "Chinhoyi School",
  stationType: "digital",
  status: "active",
  hardware: "Ecowitt GW1100",
  countryCode: "ZW",
  location: { type: "Point", coordinates: [30.2, -17.36] },
  elevationMetres: 1150,
  registeredAt: "2026-11-13T09:00:00.000Z",
  lastSeenAt: "2026-11-13T09:05:00.000Z",
  lastObservationAt: "2026-11-13T09:04:30.000Z",
};

export const EXAMPLE_REGISTERED = {
  ...EXAMPLE_STATION,
  lastSeenAt: null,
  lastObservationAt: null,
  ingestKey: "<shown once, 32 characters>",
  ingest: {
    wunderground: {
      server: "weather-ingest.nyuchi.com",
      path: "/stations/ingest",
      params: "ID=<stationId>&PASSWORD=<ingestKey>",
    },
    ecowitt: {
      server: "weather-ingest.nyuchi.com",
      path: "/stations/ingest",
      note: "Set the customized upload PASSKEY to <stationId>:<ingestKey>",
    },
  },
};

export const EXAMPLE_READINGS_OUT = {
  accepted: 1,
  rejected: 1,
  errors: [
    {
      index: 1,
      code: "out_of_range",
      detail: "Must be between -50 and 60 in this unit.",
      field: "temperatureC",
    },
  ],
  results: [
    {
      index: 0,
      status: "stored",
      qcStatus: "validated",
      observationId: "0b6e7f4a-3c1d-5a52-8f6e-2d1c9a7b4e10",
      observedAt: "2026-06-29T09:55:00.000Z",
    },
    {
      index: 1,
      status: "rejected",
      qcStatus: "rejected",
      observationId: null,
      observedAt: null,
    },
  ],
};

export const EXAMPLE_ROTATED = {
  stationId: "mws-0a1b2c3d",
  ingestKey: "<shown once>",
  rotatedAt: "2026-11-13T09:00:00.000Z",
};

/** RFC 9457, as `gateway/lib/problem.py` writes it. */
export const EXAMPLE_PROBLEM = {
  type: "about:blank",
  title: "Service Unavailable",
  status: 503,
  detail: "Stations are not available right now.",
  instance: "/v1/stations",
  code: "stations_unavailable",
};

/** The token exchange answer (docs/AUTH.md, RFC 8693). */
export const EXAMPLE_TOKEN = {
  access_token: "<a 15 minute platform JWT>",
  issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
  token_type: "Bearer",
  expires_in: 900,
  scope: "stations",
};

export const EXAMPLE_ENSURED = { person_id: "<person id>", created: true };

// --- the fake -------------------------------------------------------------------------------

export interface FakeOptions {
  port?: number;
  clientId?: string;
  clientSecret?: string;
  /** The `server` the API tells stations to upload to. */
  ingestServer?: string;
  /** Seconds an exchanged token lives. */
  tokenLifetimeSeconds?: number;
  /** Registrations per person per hour before a 429. The API allows 10. */
  registrationLimit?: number;
  /** The API allows 50 active stations per person. */
  maxStations?: number;
  /** WorkOS users that already have a person; everyone else needs `ensure`. */
  knownUsers?: string[];
}

export interface Fault {
  method?: string;
  /** Exact path, or a regular expression tested against it. */
  path: string | RegExp;
  status: number;
  code?: string;
  /** OAuth-shaped (`{detail: {error}}`), as the token exchange answers. */
  oauth?: boolean;
  /** Answer this body as it is, with `status`, instead of a problem (a 200 that rejects a reading, say). */
  reply?: unknown;
  /** How many times to fail before behaving; default once. */
  times?: number;
}

export interface RecordedRequest {
  method: string;
  /** Path and query, as sent. */
  url: string;
  path: string;
  authorization: string | null;
  clientIdHeader: string | null;
  clientSecretHeader: string | null;
  contentType: string | null;
  /** Parsed JSON, or the form's fields, or null. */
  body: unknown;
  /** Which credential reached the route. */
  as: "none" | "person" | "station-key" | "client-key" | "unknown";
}

export interface FakeStation {
  stationId: string;
  name: string;
  stationType: "digital" | "manual";
  hardware: string | null;
  countryCode: string;
  lat: number;
  lon: number;
  ownerType: "person" | "community";
  ownerId: string | null;
  keyDigest: string;
  registeredAt: string;
  lastSeenAt: string | null;
  observations: { observedAt: string; metrics: Record<string, number> }[];
}

export interface FakeNyuchiApi {
  url: string;
  port: number;
  clientId: string;
  clientSecret: string;
  requests: RecordedRequest[];
  stations: Map<string, FakeStation>;
  /** WorkOS user id to person id. */
  persons: Map<string, string>;
  stats: { exchanges: number; ensures: number };
  setUnavailable(on: boolean): void;
  queueFault(fault: Fault): void;
  /** A legacy station: community-owned, opened by its key. */
  seedCommunityStation(input: {
    stationId: string;
    key: string;
    name?: string;
  }): void;
  reset(): void;
  close(): Promise<void>;
}

const PHRASES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

const QC: Record<string, readonly [number, number, string]> = {
  temperatureC: [-50, 60, "airTemperatureCelsius"],
  humidityPct: [0, 100, "relativeHumidityPercent"],
  pressureHpa: [800, 1100, "atmosphericPressureMillibar"],
  rainfallMm: [0, 500, "precipitationMillimeters"],
  windSpeedKph: [0, 250, "windSpeedKph"],
  windSpeedMs: [0, 250 / 3.6, "windSpeedKph"],
  windDirDeg: [0, 360, "windDirectionDegrees"],
  uvIndex: [0, 20, "uvIndex"],
};

const MAX_BODY = 64 * 1024;
const ID_RE = /^mws-[a-f0-9]{8}$/;
const SUBJECT_RE = /^(?:mock-access-token|authkit)\.([a-z0-9-]{1,32})$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const round2 = (n: number) => Math.round(n * 100 + Number.EPSILON) / 100;
const clone = <T>(v: T): T => structuredClone(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

export async function startFakeNyuchiApi(
  options: FakeOptions = {},
): Promise<FakeNyuchiApi> {
  const clientId = options.clientId ?? "nyk_fake_console";
  const clientSecret = options.clientSecret ?? "nys_fake_console_secret";
  const ingestServer = options.ingestServer ?? "ingest.fake-nyuchi.test";
  const lifetime = options.tokenLifetimeSeconds ?? 900;
  const registrationLimit = options.registrationLimit ?? 10;
  const maxStations = options.maxStations ?? 50;

  const requests: RecordedRequest[] = [];
  const stations = new Map<string, FakeStation>();
  const persons = new Map<string, string>();
  const tokens = new Map<string, { personId: string; expiresAt: number }>();
  const registrations = new Map<string, number>();
  const faults: (Fault & { left: number })[] = [];
  const stats = { exchanges: 0, ensures: 0 };
  let unavailable = false;

  const reset = () => {
    requests.length = 0;
    stations.clear();
    persons.clear();
    tokens.clear();
    registrations.clear();
    faults.length = 0;
    stats.exchanges = 0;
    stats.ensures = 0;
    unavailable = false;
    for (const u of options.knownUsers ?? []) persons.set(u, `person-${u}`);
  };
  reset();

  function send(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
    type = "application/json",
  ) {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify(body));
  }

  function problem(
    res: ServerResponse,
    path: string,
    status: number,
    detail: string,
    code: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    send(
      res,
      status,
      {
        ...clone(EXAMPLE_PROBLEM),
        title: PHRASES[status] ?? "Error",
        status,
        detail,
        instance: path,
        code,
        ...extra,
      },
      headers,
      "application/problem+json",
    );
  }

  function oauthError(
    res: ServerResponse,
    status: number,
    error: string,
    description: string,
  ) {
    send(res, status, {
      detail: { error, error_description: description },
    });
  }

  function stationOut(s: FakeStation) {
    const latest = s.observations.at(-1);
    return {
      ...clone(EXAMPLE_STATION),
      stationId: s.stationId,
      name: s.name,
      stationType: s.stationType,
      status: "active",
      hardware: s.hardware,
      countryCode: s.countryCode,
      location: { type: "Point", coordinates: [s.lon, s.lat] },
      elevationMetres: null,
      registeredAt: s.registeredAt,
      lastSeenAt: s.lastSeenAt,
      lastObservationAt: latest?.observedAt ?? null,
    };
  }

  function newStationId(): string {
    for (;;) {
      const id = `mws-${randomBytes(4).toString("hex")}`;
      if (!stations.has(id)) return id;
    }
  }

  /** The caller of a /v1/stations route: a person's token, or anything else (a station key). */
  function caller(req: IncomingMessage): {
    bearer: string | null;
    person: string | null;
  } {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const entry = bearer ? tokens.get(bearer) : undefined;
    const person =
      entry && entry.expiresAt > Date.now() ? entry.personId : null;
    return { bearer, person };
  }

  async function readBody(
    req: IncomingMessage,
  ): Promise<{ text: string; tooBig: boolean }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return { text: "", tooBig: true };
      chunks.push(chunk as Buffer);
    }
    return { text: Buffer.concat(chunks).toString("utf8"), tooBig: false };
  }

  function takeFault(method: string, path: string): Fault | null {
    const i = faults.findIndex(
      (f) =>
        (!f.method || f.method === method) &&
        (typeof f.path === "string" ? f.path === path : f.path.test(path)),
    );
    const fault = faults[i];
    if (!fault) return null;
    fault.left -= 1;
    if (fault.left <= 0) faults.splice(i, 1);
    return fault;
  }

  // --- /v1/auth/token and /v1/identity/persons/ensure -------------------------------

  function checkClient(
    req: IncomingMessage,
    id: string | undefined,
    secret: string | undefined,
  ): boolean {
    const headerId = req.headers["x-client-id"];
    const headerSecret = req.headers["x-client-secret"];
    const headersMatch =
      headerId === undefined || (headerId === id && headerSecret === secret);
    return id === clientId && secret === clientSecret && headersMatch;
  }

  function subjectUser(token: unknown): string | null {
    return typeof token === "string"
      ? (SUBJECT_RE.exec(token)?.[1] ?? null)
      : null;
  }

  function exchange(
    req: IncomingMessage,
    res: ServerResponse,
    form: URLSearchParams,
  ) {
    stats.exchanges += 1;
    const id = form.get("client_id") ?? undefined;
    const secret = form.get("client_secret") ?? undefined;
    if (!checkClient(req, id, secret))
      return oauthError(
        res,
        401,
        "invalid_client",
        "Invalid client credentials",
      );
    if (
      form.get("grant_type") !==
      "urn:ietf:params:oauth:grant-type:token-exchange"
    )
      return oauthError(
        res,
        400,
        "unsupported_grant_type",
        "Use token exchange",
      );
    if (
      !form.get("subject_token") ||
      form.get("subject_token_type") !==
        "urn:ietf:params:oauth:token-type:access_token"
    )
      return oauthError(res, 400, "invalid_request", "Send subject_token");
    if (form.get("scope") !== "stations")
      return oauthError(res, 400, "invalid_scope", "Only stations is granted");
    const user = subjectUser(form.get("subject_token"));
    if (!user)
      return oauthError(
        res,
        400,
        "invalid_grant",
        "The subject token is not valid",
      );
    const personId = persons.get(user);
    if (!personId)
      return oauthError(
        res,
        404,
        "person_not_found",
        "No person is linked to this WorkOS user.",
      );
    const token = `ptok.${randomBytes(12).toString("hex")}`;
    tokens.set(token, { personId, expiresAt: Date.now() + lifetime * 1000 });
    send(res, 200, {
      ...clone(EXAMPLE_TOKEN),
      access_token: token,
      expires_in: lifetime,
    });
  }

  function ensure(req: IncomingMessage, res: ServerResponse, body: unknown) {
    stats.ensures += 1;
    if (
      !checkClient(
        req,
        req.headers["x-client-id"] as string | undefined,
        req.headers["x-client-secret"] as string | undefined,
      )
    )
      return oauthError(
        res,
        401,
        "invalid_client",
        "Send the key as X-Client-Id/X-Client-Secret.",
      );
    const subject = isRecord(body) ? body.subject_token : undefined;
    const user = subjectUser(subject);
    if (!user)
      return oauthError(
        res,
        400,
        "invalid_grant",
        "The subject token is not valid",
      );
    const existing = persons.get(user);
    if (existing)
      return send(res, 200, {
        ...clone(EXAMPLE_ENSURED),
        person_id: existing,
        created: false,
      });
    const personId = `person-${user}`;
    persons.set(user, personId);
    send(res, 201, {
      ...clone(EXAMPLE_ENSURED),
      person_id: personId,
      created: true,
    });
  }

  // --- /v1/stations ------------------------------------------------------------------

  function validationError(
    res: ServerResponse,
    path: string,
    errors: { pointer: string; detail: string; code: string }[],
  ) {
    problem(res, path, 422, "The request is not valid.", "validation_error", {
      errors,
    });
  }

  function register(
    res: ServerResponse,
    path: string,
    person: string,
    body: unknown,
  ) {
    const errors: { pointer: string; detail: string; code: string }[] = [];
    const bad = (pointer: string, detail: string) =>
      errors.push({ pointer, detail, code: "invalid" });
    const b = isRecord(body) ? body : {};
    const allowed = new Set([
      "name",
      "lat",
      "lon",
      "elevation",
      "stationType",
      "hardware",
      "country",
    ]);
    for (const k of Object.keys(b))
      if (!allowed.has(k)) bad(`#/${k}`, "Extra inputs are not permitted");
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name.length < 2 || name.length > 80)
      bad("#/name", "Must be 2 to 80 characters");
    if (!isNumber(b.lat) || b.lat < -90 || b.lat > 90)
      bad("#/lat", "Must be between -90 and 90");
    if (!isNumber(b.lon) || b.lon < -180 || b.lon > 180)
      bad("#/lon", "Must be between -180 and 180");
    const stationType = b.stationType ?? "digital";
    if (stationType !== "digital" && stationType !== "manual")
      bad("#/stationType", "Must be digital or manual");
    if (
      b.country !== undefined &&
      b.country !== null &&
      !(typeof b.country === "string" && /^[A-Za-z]{2}$/.test(b.country))
    )
      bad("#/country", "Must be two letters");
    if (
      b.hardware !== undefined &&
      b.hardware !== null &&
      (typeof b.hardware !== "string" || b.hardware.length > 80)
    )
      bad("#/hardware", "Must be at most 80 characters");
    if (errors.length) return validationError(res, path, errors);

    const mine = [...stations.values()].filter(
      (s) => s.ownerId === person && s.ownerType === "person",
    );
    if (mine.length >= maxStations)
      return problem(
        res,
        path,
        409,
        `You have ${maxStations} stations, the most one person may register.`,
        "station_limit_reached",
      );
    const made = (registrations.get(person) ?? 0) + 1;
    registrations.set(person, made);
    if (made > registrationLimit)
      return problem(
        res,
        path,
        429,
        "Too many requests. Try again later.",
        "rate_limited",
        {},
        { "Retry-After": "3600" },
      );

    const key = randomBytes(24).toString("base64url");
    const station: FakeStation = {
      stationId: newStationId(),
      name,
      stationType: stationType as "digital" | "manual",
      hardware:
        typeof b.hardware === "string" && b.hardware.trim()
          ? b.hardware.trim()
          : null,
      // The API files an omitted country under ZW.
      countryCode:
        typeof b.country === "string" ? b.country.toUpperCase() : "ZW",
      lat: b.lat as number,
      lon: b.lon as number,
      ownerType: "person",
      ownerId: person,
      keyDigest: sha256(key),
      registeredAt: new Date().toISOString(),
      lastSeenAt: null,
      observations: [],
    };
    stations.set(station.stationId, station);
    const out = clone(EXAMPLE_REGISTERED);
    send(res, 201, {
      ...out,
      ...stationOut(station),
      ingestKey: key,
      ingest: {
        wunderground: { ...out.ingest.wunderground, server: ingestServer },
        ecowitt: { ...out.ingest.ecowitt, server: ingestServer },
      },
    });
  }

  function readings(
    res: ServerResponse,
    path: string,
    station: FakeStation,
    body: unknown,
  ) {
    const b = isRecord(body) ? body : null;
    const list = b && Array.isArray(b.readings) ? b.readings : null;
    if (!b || !list || list.length < 1 || list.length > 100)
      return validationError(res, path, [
        {
          pointer: "#/readings",
          detail: "Send 1 to 100 readings",
          code: "invalid",
        },
      ]);
    for (const k of Object.keys(b))
      if (k !== "stationType" && k !== "readings")
        return validationError(res, path, [
          {
            pointer: `#/${k}`,
            detail: "Extra inputs are not permitted",
            code: "extra_forbidden",
          },
        ]);
    if (b.stationType !== undefined && b.stationType !== "generic")
      return validationError(res, path, [
        {
          pointer: "#/stationType",
          detail: "Only generic is accepted",
          code: "invalid",
        },
      ]);
    for (const [i, r] of list.entries()) {
      if (!isRecord(r))
        return validationError(res, path, [
          {
            pointer: `#/readings/${i}`,
            detail: "Must be an object",
            code: "invalid",
          },
        ]);
      for (const k of Object.keys(r))
        if (k !== "observedAt" && !(k in QC))
          return validationError(res, path, [
            {
              pointer: `#/readings/${i}/${k}`,
              detail: "Extra inputs are not permitted",
              code: "extra_forbidden",
            },
          ]);
      if (list.length > 1 && r.observedAt === undefined)
        return validationError(res, path, [
          {
            pointer: `#/readings/${i}/observedAt`,
            detail: "Required when sending more than one",
            code: "invalid",
          },
        ]);
    }

    const now = Date.now();
    const errors: {
      index: number;
      code: string;
      detail: string;
      field: string | null;
    }[] = [];
    const results = clone(EXAMPLE_READINGS_OUT.results).slice(0, 0) as Record<
      string,
      unknown
    >[];
    let accepted = 0;
    for (const [index, r] of list.entries() as IterableIterator<
      [number, Record<string, unknown>]
    >) {
      const rejectedResult = {
        index,
        status: "rejected",
        qcStatus: "rejected",
        observationId: null,
        observedAt: null,
      };
      let observedAt = now;
      if (r.observedAt !== undefined) {
        observedAt =
          typeof r.observedAt === "string"
            ? Date.parse(r.observedAt)
            : Number.NaN;
        if (
          !Number.isFinite(observedAt) ||
          observedAt > now + 5 * 60_000 ||
          observedAt < now - 7 * 86_400_000
        ) {
          errors.push({
            index,
            code: "observed_at_out_of_range",
            detail:
              "Must be within the last 7 days and no more than 5 minutes ahead.",
            field: "observedAt",
          });
          results.push(rejectedResult);
          continue;
        }
      }
      const problems: typeof errors = [];
      const metrics: Record<string, number> = {};
      if (r.windSpeedMs !== undefined && r.windSpeedKph !== undefined)
        problems.push({
          index,
          code: "conflicting_fields",
          detail: "Send windSpeedMs or windSpeedKph, not both.",
          field: "windSpeedKph",
        });
      for (const [field, spec] of Object.entries(QC)) {
        const v = r[field];
        if (v === undefined || v === null) continue;
        if (!isNumber(v))
          problems.push({
            index,
            code: "invalid_number",
            detail: "Must be a number.",
            field,
          });
        else if (v < spec[0] || v > spec[1])
          problems.push({
            index,
            code: "out_of_range",
            detail: `Must be between ${spec[0]} and ${spec[1]} in this unit.`,
            field,
          });
        else metrics[spec[2]] = round2(field === "windSpeedMs" ? v * 3.6 : v);
      }
      if (problems.length === 0 && Object.keys(metrics).length === 0)
        problems.push({
          index,
          code: "no_measurement",
          detail: "A reading needs at least one measurement.",
          field: null,
        });
      if (problems.length) {
        errors.push(...problems);
        results.push(rejectedResult);
        continue;
      }
      const at = new Date(observedAt).toISOString();
      const duplicate = station.observations.some((o) => o.observedAt === at);
      if (!duplicate) station.observations.push({ observedAt: at, metrics });
      station.observations.sort((x, y) =>
        x.observedAt.localeCompare(y.observedAt),
      );
      accepted += 1;
      results.push({
        index,
        status: duplicate ? "duplicate" : "stored",
        qcStatus: "validated",
        observationId: randomBytes(16).toString("hex"),
        observedAt: at,
      });
    }
    if (accepted > 0) station.lastSeenAt = new Date().toISOString();
    send(res, 200, {
      ...clone(EXAMPLE_READINGS_OUT),
      accepted,
      rejected: list.length - accepted,
      errors,
      results,
    });
  }

  async function stationsRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    body: unknown,
    record: RecordedRequest,
  ) {
    if (unavailable)
      return problem(
        res,
        path,
        503,
        "Stations are not available right now.",
        "stations_unavailable",
      );
    const rest = path.slice("/v1/stations".length);
    const parts = rest.split("/").filter(Boolean);
    const { bearer, person } = caller(req);
    record.as = person ? "person" : bearer ? "station-key" : "none";

    const needPerson = (): string | null => {
      if (person) return person;
      if (!bearer)
        problem(
          res,
          path,
          401,
          "Sign in to manage stations.",
          "authentication_required",
          {},
          { "WWW-Authenticate": "Bearer" },
        );
      else
        problem(
          res,
          path,
          401,
          "Invalid or expired token.",
          "invalid_token",
          {},
          { "WWW-Authenticate": "Bearer" },
        );
      return null;
    };
    const notFound = () =>
      problem(res, path, 404, "No such station.", "station_not_found");

    if (parts.length === 0) {
      if (method === "POST") {
        const p = needPerson();
        return p ? register(res, path, p, body) : undefined;
      }
      if (method === "GET") {
        const p = needPerson();
        if (!p) return;
        const mine = [...stations.values()]
          .filter((s) => s.ownerType === "person" && s.ownerId === p)
          .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
        return send(res, 200, {
          stations: mine.map(stationOut),
          count: mine.length,
        });
      }
      return problem(
        res,
        path,
        405,
        "Method not allowed.",
        "method_not_allowed",
      );
    }

    const id = parts[0] ?? "";
    const tail = parts[1];
    if (parts.length > 2 || !ID_RE.test(id))
      return problem(
        res,
        path,
        422,
        "The station id is not valid.",
        "validation_error",
      );
    const station = stations.get(id);

    if (
      (method === "GET" && !tail) ||
      (method === "POST" && tail === "readings")
    ) {
      // The owner (a person token), or whoever holds the station's key. A
      // bearer that is not a live person token is treated as a key, so an
      // expired token is `invalid_credentials`, as it is at the real API.
      if (!person && bearer) {
        if (station && station.keyDigest === sha256(bearer))
          return method === "GET"
            ? send(res, 200, {
                ...stationOut(station),
                latestMetrics: station.observations.at(-1)?.metrics ?? null,
              })
            : readings(res, path, station, body);
        return problem(
          res,
          path,
          401,
          "Invalid credentials.",
          "invalid_credentials",
          {},
          { "WWW-Authenticate": 'Bearer realm="nyuchi-api"' },
        );
      }
      const p = needPerson();
      if (!p) return;
      if (!station || station.ownerType !== "person" || station.ownerId !== p)
        return notFound();
      return method === "GET"
        ? send(res, 200, {
            ...stationOut(station),
            latestMetrics: station.observations.at(-1)?.metrics ?? null,
          })
        : readings(res, path, station, body);
    }

    if (method === "POST" && tail === "rotate-key") {
      const p = needPerson();
      if (!p) return;
      if (!station || station.ownerType !== "person" || station.ownerId !== p)
        return notFound();
      const key = randomBytes(24).toString("base64url");
      station.keyDigest = sha256(key);
      return send(res, 200, {
        ...clone(EXAMPLE_ROTATED),
        stationId: station.stationId,
        ingestKey: key,
        rotatedAt: new Date().toISOString(),
      });
    }

    if (method === "POST" && tail === "claim") {
      const p = needPerson();
      if (!p) return;
      if (station && station.ownerType === "person" && station.ownerId === p)
        return send(res, 200, stationOut(station));
      if (!station || station.ownerType !== "community") return notFound();
      const given =
        isRecord(body) && typeof body.ingestKey === "string"
          ? body.ingestKey
          : "";
      if (sha256(given) !== station.keyDigest)
        return problem(
          res,
          path,
          403,
          "That is not this station's key.",
          "invalid_station_key",
        );
      station.ownerType = "person";
      station.ownerId = p;
      return send(res, 200, stationOut(station));
    }
    return problem(res, path, 404, "Not found.", "not_found");
  }

  // --- the server --------------------------------------------------------------------------

  const server: Server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      const path = url.split("?")[0] ?? "/";
      const { text, tooBig } = await readBody(req);

      // Test controls: not part of the API.
      if (path === "/__fake/requests") return send(res, 200, requests);
      if (path === "/__fake/stats")
        return send(res, 200, {
          ...stats,
          stations: stations.size,
          persons: persons.size,
        });
      if (path === "/__fake/reset" && method === "POST") {
        reset();
        return send(res, 200, { ok: true });
      }
      if (path === "/__fake/unavailable" && method === "POST") {
        unavailable = text.trim() === "true";
        return send(res, 200, { unavailable });
      }
      if (path === "/__fake/fault" && method === "POST") {
        const f = JSON.parse(text) as Omit<Fault, "path"> & {
          path: string;
          pattern?: string;
        };
        faults.push({
          ...f,
          path: f.pattern ? new RegExp(f.pattern) : f.path,
          left: f.times ?? 1,
        });
        return send(res, 200, { ok: true });
      }
      if (path === "/__fake/community" && method === "POST") {
        const f = JSON.parse(text) as {
          stationId: string;
          key: string;
          name?: string;
        };
        api.seedCommunityStation(f);
        return send(res, 200, { ok: true });
      }

      let body: unknown = null;
      const contentType = req.headers["content-type"] ?? null;
      if (text) {
        try {
          body = contentType?.includes("application/x-www-form-urlencoded")
            ? Object.fromEntries(new URLSearchParams(text))
            : JSON.parse(text);
        } catch {
          body = null;
        }
      }
      const header = (name: string) => {
        const v = req.headers[name];
        return typeof v === "string" ? v : null;
      };
      const record: RecordedRequest = {
        method,
        url,
        path,
        authorization: header("authorization"),
        clientIdHeader: header("x-client-id"),
        clientSecretHeader: header("x-client-secret"),
        contentType,
        body,
        as:
          path === "/v1/auth/token" || path === "/v1/identity/persons/ensure"
            ? "client-key"
            : "unknown",
      };
      requests.push(record);

      if (tooBig)
        return problem(
          res,
          path,
          413,
          "The request body is too large.",
          "payload_too_large",
        );
      const fault = takeFault(method, path);
      if (fault && fault.reply !== undefined)
        return send(res, fault.status, fault.reply);
      if (fault)
        return fault.oauth
          ? oauthError(
              res,
              fault.status,
              fault.code ?? "server_error",
              "Injected by the test",
            )
          : problem(
              res,
              path,
              fault.status,
              "Injected by the test.",
              fault.code ?? "injected",
            );

      if (path === "/v1/auth/token" && method === "POST")
        return exchange(req, res, new URLSearchParams(text));
      if (path === "/v1/identity/persons/ensure" && method === "POST")
        return ensure(req, res, body);
      if (path === "/v1/stations" || path.startsWith("/v1/stations/"))
        return stationsRoute(req, res, method, path, body, record);
      return problem(res, path, 404, "Not found.", "not_found");
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: "fake failed" });
      else res.end();
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : (options.port ?? 0);

  const api: FakeNyuchiApi = {
    url: `http://127.0.0.1:${port}`,
    port,
    clientId,
    clientSecret,
    requests,
    stations,
    persons,
    stats,
    setUnavailable: (on) => {
      unavailable = on;
    },
    queueFault: (f) => {
      faults.push({ ...f, left: f.times ?? 1 });
    },
    seedCommunityStation: ({ stationId, key, name }) => {
      stations.set(stationId, {
        stationId,
        name: name ?? "Legacy station",
        stationType: "manual",
        hardware: null,
        countryCode: "ZW",
        lat: -17.8,
        lon: 31.05,
        ownerType: "community",
        ownerId: null,
        keyDigest: sha256(key),
        registeredAt: new Date().toISOString(),
        lastSeenAt: null,
        observations: [],
      });
    },
    reset,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return api;
}

// Run directly: `node --experimental-strip-types e2e/support/fake-nyuchi-api.ts --port 4410`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--port");
  const port = at > 0 ? Number(process.argv[at + 1]) : 4410;
  const api = await startFakeNyuchiApi({
    port,
    clientId: process.env.FAKE_CLIENT_ID ?? "nyk_e2e_console",
    clientSecret: process.env.FAKE_CLIENT_SECRET ?? "nys_e2e_console_secret",
    ingestServer: process.env.FAKE_INGEST_SERVER ?? "ingest.fake-nyuchi.test",
  });
  process.stdout.write(`fake Nyuchi API listening on ${api.url}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => void api.close().then(() => process.exit(0)));
}
