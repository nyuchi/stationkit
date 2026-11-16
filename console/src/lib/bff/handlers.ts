import {
  type Caller,
  type KeyAuth,
  StationsApiError,
  type StationsClient,
} from "../stations/types";
import {
  isStationId,
  isStationKey,
  parseReadingInput,
  parseRegisterInput,
} from "../stations/validators";

export interface BffRequest {
  method: string;
  origin: string;
  /** The `Origin` request header, when present. */
  requestOrigin: string | null;
  contentType: string | null;
  stationKey: string | null;
  /** Parsed lazily so malformed bodies become 400s, not exceptions. */
  json: () => Promise<unknown>;
}

export interface BffResponse {
  status: number;
  body: unknown;
}

const fail = (status: number, error: string): BffResponse => ({
  status,
  body: { error },
});

function keyAuth(req: BffRequest): KeyAuth | undefined {
  return req.stationKey ? { stationKey: req.stationKey } : undefined;
}

/** A station key that is not a key is refused here, not sent on to the API. */
function checkKey(req: BffRequest): BffResponse | null {
  return req.stationKey && !isStationKey(req.stationKey)
    ? fail(400, "Invalid station key")
    : null;
}

/** Same-origin only: browsers send Origin on cross-site POSTs. */
function checkOrigin(req: BffRequest): BffResponse | null {
  return req.requestOrigin !== null && req.requestOrigin !== req.origin
    ? fail(403, "Cross-origin requests are not allowed")
    : null;
}

/** A write that carries a JSON body: same-origin, and JSON. */
export function checkWrite(req: BffRequest): BffResponse | null {
  const crossOrigin = checkOrigin(req);
  if (crossOrigin) return crossOrigin;
  if (!req.contentType?.toLowerCase().startsWith("application/json"))
    return fail(415, "Send application/json");
  return null;
}

async function guarded(run: () => Promise<BffResponse>): Promise<BffResponse> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof StationsApiError) return fail(err.status, err.message);
    // Deliberately no detail: error objects can echo upstream URLs or keys.
    return fail(500, "Something went wrong. Try again.");
  }
}

export function unauthenticated(): BffResponse {
  return fail(401, "Sign in to use the station console");
}

export function registerStation(
  client: StationsClient,
  caller: Caller,
  req: BffRequest,
) {
  return guarded(async () => {
    const blocked = checkWrite(req);
    if (blocked) return blocked;
    const parsed = parseRegisterInput(await req.json().catch(() => null));
    if (!parsed.ok) return fail(400, parsed.error);
    return { status: 201, body: await client.register(caller, parsed.value) };
  });
}

export function listStations(client: StationsClient, caller: Caller) {
  return guarded(async () => ({
    status: 200,
    body: { stations: await client.list(caller) },
  }));
}

export function stationStatus(
  client: StationsClient,
  caller: Caller,
  id: string,
  req: BffRequest,
) {
  return guarded(async () => {
    if (!isStationId(id)) return fail(400, "Invalid station id");
    const badKey = checkKey(req);
    if (badKey) return badKey;
    return { status: 200, body: await client.status(caller, id, keyAuth(req)) };
  });
}

export function submitReading(
  client: StationsClient,
  caller: Caller,
  id: string,
  req: BffRequest,
) {
  return guarded(async () => {
    const blocked = checkWrite(req);
    if (blocked) return blocked;
    if (!isStationId(id)) return fail(400, "Invalid station id");
    const badKey = checkKey(req);
    if (badKey) return badKey;
    const parsed = parseReadingInput(await req.json().catch(() => null));
    if (!parsed.ok) return fail(400, parsed.error);
    return {
      status: 200,
      body: await client.submitReading(caller, id, parsed.value, keyAuth(req)),
    };
  });
}

export function rotateKey(
  client: StationsClient,
  caller: Caller,
  id: string,
  req: BffRequest,
) {
  return guarded(async () => {
    // Rotation needs no body, but still must be a same-origin write.
    const blocked = checkOrigin(req);
    if (blocked) return blocked;
    if (!isStationId(id)) return fail(400, "Invalid station id");
    return { status: 200, body: await client.rotateKey(caller, id) };
  });
}

/**
 * Take over a legacy station. The proof is the station's key, which arrives
 * in `X-Station-Key` like every other station key (never in a URL, never in a
 * body this BFF logs) and goes to the API in the body it expects.
 */
export function claimStation(
  client: StationsClient,
  caller: Caller,
  id: string,
  req: BffRequest,
) {
  return guarded(async () => {
    const blocked = checkOrigin(req);
    if (blocked) return blocked;
    if (!isStationId(id)) return fail(400, "Invalid station id");
    if (!req.stationKey)
      return fail(400, "Send the station's key to claim it.");
    const badKey = checkKey(req);
    if (badKey) return badKey;
    return {
      status: 200,
      body: await client.claim(caller, id, { stationKey: req.stationKey }),
    };
  });
}
