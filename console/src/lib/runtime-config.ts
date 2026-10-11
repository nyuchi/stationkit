import { NYUCHI_API_URL, NYUCHI_INGEST_HOST, STATIONS_BACKEND } from "astro:env/server";
import { createStationsClient, resolveConfig } from "./config";

/** Reads the typed environment once per request and picks the client. */
export function runtime() {
  const config = resolveConfig(
    { STATIONS_BACKEND, NYUCHI_API_URL, NYUCHI_INGEST_HOST },
    { prod: import.meta.env.PROD },
  );
  // The demo station (and its public key) exists only in `astro dev`.
  return { config, client: createStationsClient(config, { seedDemo: import.meta.env.DEV }) };
}
