import type { IngestHint, IngestSetup } from "./stations/types";

/**
 * The station ingest host that hardware is pointed at. Confirmed against the
 * Rust stations Worker source (its INGEST_HOST fallback is this host, and it
 * serves GET and POST /stations/ingest) and a live probe on 2026-10-11:
 * `/health` answers 200 and `/stations/ingest` answers 401 for a wrong key.
 * The owner should still confirm it as the product's published host.
 *
 * This is only the fallback. At registration the Nyuchi API says where a
 * station uploads (its `ingest` field) and the console shows that instead.
 */
export const DEFAULT_INGEST_HOST = "weather-ingest.nyuchi.com";

/** Wunderground (GET) and Ecowitt (POST) both use this path on the ingest host. */
export const INGEST_PATH = "/stations/ingest";

export const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i;

/** A path only: no query, fragment, whitespace or control characters, and not scheme-relative (`//host`). */
const PATH_RE = /^\/(?!\/)[A-Za-z0-9._~\-/]{0,200}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One protocol's target, or null if the API sent something that is not a host and a path. */
export function parseIngestHint(v: unknown): IngestHint | null {
  if (!isRecord(v)) return null;
  const { server, path } = v;
  if (typeof server !== "string" || !HOST_RE.test(server)) return null;
  if (typeof path !== "string" || !PATH_RE.test(path)) return null;
  return { server, path };
}

/**
 * The API's `ingest` field, checked before it is shown (it is displayed as
 * text only, but it still must look like a host and a path). Both protocols
 * or nothing, so the console never mixes the API's host with its own.
 */
export function parseIngestSetup(v: unknown): IngestSetup | null {
  if (!isRecord(v)) return null;
  const wunderground = parseIngestHint(v.wunderground);
  const ecowitt = parseIngestHint(v.ecowitt);
  return wunderground && ecowitt ? { wunderground, ecowitt } : null;
}
