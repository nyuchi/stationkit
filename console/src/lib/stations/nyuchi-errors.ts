import { StationsApiError } from "./types";

/**
 * How the Nyuchi API's failures become the console's own. Every answer is
 * fixed text: the API's `detail`, `errors` and anything else it says is never
 * forwarded, so a key, a token or a store message cannot reach the browser
 * even if the API were to echo one.
 *
 * The API answers in RFC 9457 problems (`code`, stable and machine-readable)
 * and, on the token exchange, in OAuth errors (`detail.error`).
 */

export const NOT_LIVE_MESSAGE = "Station registration is not live yet";
export const UNAVAILABLE_MESSAGE = "The station service is unavailable";
export const GENERIC_MESSAGE =
  "The station service could not complete that request.";
export const RATE_LIMIT_MESSAGE = "Too many requests. Try again later.";
export const REJECTED_MESSAGE = "The station service rejected that request.";
export const KEY_NOT_ACCEPTED_MESSAGE = "That station key was not accepted.";
export const SIGN_IN_AGAIN_MESSAGE =
  "The station service could not verify your sign-in. Sign out and sign in again.";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const CODE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/**
 * The stable name of a failure: a problem's `code`, an OAuth error's `error`
 * (inside `detail` on the token exchange), or null when there is none.
 */
export function failureCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const found = [
    body.code,
    isRecord(body.detail) ? body.detail.error : undefined,
    body.error,
  ].find((c): c is string => typeof c === "string" && CODE_RE.test(c));
  return found ?? null;
}

/** A failed `/v1/stations*` call. A 401 is handled by the caller: it depends on what the bearer was. */
export function mapStationFailure(
  status: number,
  code: string | null,
): StationsApiError {
  switch (code) {
    case "stations_unavailable":
      return new StationsApiError(503, NOT_LIVE_MESSAGE);
    case "station_not_found":
      return new StationsApiError(404, "Station not found");
    case "station_limit_reached":
      return new StationsApiError(
        409,
        "You already have the most stations one person can register.",
      );
    case "invalid_station_key":
      return new StationsApiError(403, "That is not this station's key.");
    case "rate_limited":
      return new StationsApiError(429, RATE_LIMIT_MESSAGE);
    case "payload_too_large":
      return new StationsApiError(400, REJECTED_MESSAGE);
  }
  if (status === 404) return new StationsApiError(404, "Station not found");
  if (status === 429) return new StationsApiError(429, RATE_LIMIT_MESSAGE);
  if (status === 400 || status === 413 || status === 422)
    return new StationsApiError(400, REJECTED_MESSAGE);
  // Everything else, including a 401 or 403 about the console's own
  // credentials, is the platform's problem, never "you are signed out".
  return new StationsApiError(502, GENERIC_MESSAGE);
}

/** A failed token exchange or person provisioning. */
export function mapIdentityFailure(
  status: number,
  code: string | null,
): StationsApiError {
  if (status === 429 || code === "slow_down")
    return new StationsApiError(429, RATE_LIMIT_MESSAGE);
  // Not a 401: the browser signs people in again on a 401, and a console whose
  // own key or client id is wrong would then send everyone round in a circle.
  if (code === "invalid_grant")
    return new StationsApiError(502, SIGN_IN_AGAIN_MESSAGE);
  if (code === "email_not_verified")
    return new StationsApiError(
      403,
      "Verify your email address, then sign in again.",
    );
  if (status === 503 || code === "temporarily_unavailable")
    return new StationsApiError(
      503,
      "The station service is temporarily unavailable. Try again shortly.",
    );
  return new StationsApiError(502, GENERIC_MESSAGE);
}
