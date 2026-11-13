import {
  NYUCHI_API_URL,
  NYUCHI_CONSOLE_CLIENT_ID,
  NYUCHI_CONSOLE_CLIENT_SECRET,
  NYUCHI_INGEST_HOST,
  STATIONS_BACKEND,
} from "astro:env/server";
import {
  createStationsClient,
  resolveConfig,
  resolveCredentials,
} from "./config";

/** Reads the typed environment once per request and picks the client. */
export function runtime() {
  const raw = {
    STATIONS_BACKEND,
    NYUCHI_API_URL,
    NYUCHI_INGEST_HOST,
    NYUCHI_CONSOLE_CLIENT_ID,
    NYUCHI_CONSOLE_CLIENT_SECRET,
  };
  const config = resolveConfig(raw, { prod: import.meta.env.PROD });
  // The demo station (and its public key) exists only in `astro dev`.
  return {
    config,
    client: createStationsClient(config, {
      seedDemo: import.meta.env.DEV,
      credentials: resolveCredentials(raw),
    }),
  };
}
