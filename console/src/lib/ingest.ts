/**
 * The station ingest host that hardware is pointed at. Confirmed against the
 * Rust stations Worker source (its INGEST_HOST fallback is this host, and it
 * serves GET and POST /stations/ingest) and a live probe on 2026-10-11:
 * `/health` answers 200 and `/stations/ingest` answers 401 for a wrong key.
 * The owner should still confirm it as the product's published host.
 */
export const DEFAULT_INGEST_HOST = "weather-ingest.nyuchi.com";

/** Wunderground (GET) and Ecowitt (POST) both use this path on the ingest host. */
export const INGEST_PATH = "/stations/ingest";
