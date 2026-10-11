import { DEFAULT_INGEST_HOST } from "./ingest";
import type { StationsClient } from "./stations/types";
import { MockStationsClient } from "./stations/mock-client";
import { NyuchiStationsClient } from "./stations/nyuchi-client";

export interface ConsoleConfig {
  backend: "mock" | "nyuchi";
  nyuchiApiUrl: string;
  ingestHost: string;
}

export { DEFAULT_INGEST_HOST, INGEST_PATH } from "./ingest";

/** Nyuchi's API: the only host this app talks to. */
export const DEFAULT_NYUCHI_API_URL = "https://api.nyuchi.com";

const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i;

export interface RawConfig {
  STATIONS_BACKEND?: string | undefined;
  NYUCHI_API_URL?: string | undefined;
  NYUCHI_INGEST_HOST?: string | undefined;
}

export interface ConfigContext {
  /** True in a production runtime (`import.meta.env.PROD`). */
  prod: boolean;
}

/**
 * Validates the environment. A bad value fails loudly rather than silently
 * mocking, and the mock backend is refused outright in production: it would
 * hand real owners credentials the platform never issued.
 */
export function resolveConfig(
  raw: RawConfig,
  ctx: ConfigContext = { prod: false },
): ConsoleConfig {
  const requested =
    raw.STATIONS_BACKEND?.trim() || (ctx.prod ? "nyuchi" : "mock");
  if (requested !== "mock" && requested !== "nyuchi")
    throw new Error(
      `STATIONS_BACKEND must be "mock" or "nyuchi", got "${requested}"`,
    );
  if (requested === "mock" && ctx.prod)
    throw new Error(
      "STATIONS_BACKEND=mock is not allowed in a production runtime",
    );

  let parsed: URL;
  try {
    parsed = new URL(raw.NYUCHI_API_URL?.trim() || DEFAULT_NYUCHI_API_URL);
  } catch {
    throw new Error("NYUCHI_API_URL must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
    throw new Error("NYUCHI_API_URL must use https");
  const nyuchiApiUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");

  const ingestHost = raw.NYUCHI_INGEST_HOST?.trim() || DEFAULT_INGEST_HOST;
  if (!HOST_RE.test(ingestHost))
    throw new Error("NYUCHI_INGEST_HOST must be a host name");

  return { backend: requested, nyuchiApiUrl, ingestHost };
}

let mockSingleton: MockStationsClient | null = null;

/** The one place that picks a client. The mock is shared so state survives requests. */
export function createStationsClient(
  config: ConsoleConfig,
  options: { fetchImpl?: typeof fetch; seedDemo?: boolean } = {},
): StationsClient {
  if (config.backend === "nyuchi")
    return new NyuchiStationsClient(config.nyuchiApiUrl, options.fetchImpl);
  mockSingleton ??= new MockStationsClient({
    seedDemo: options.seedDemo ?? false,
  });
  return mockSingleton;
}
